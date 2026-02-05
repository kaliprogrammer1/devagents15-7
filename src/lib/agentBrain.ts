import { agentMemory, skillManager, createUserMemory, summarizeForStorage, knowledgeGraph } from './agentMemory';
import { CodeExecutor, TestRunner } from './codeExecution';
import { GitHubIntegration } from './github';
import { hierarchicalPlanner } from './hierarchicalPlanning';
import { supabaseAdmin } from './supabase';
import { codeAnalyzer, CodeEntity, CodeAnalysisResult } from './codeAnalysis';
import { getDockerManager, DockerWorkspace, DockerExecResult } from './dockerManager';
import { getWorkspaceManager, WorkspaceConfig } from './workspaceManager';
import { 
  diffEditor, 
  DiffParser, 
  LineRangeEditor,
  type ASTModification,
  type EditResult,
  type MultiFileEdit,
  type ValidationError 
} from './diffEditor';
import {
  ContextWindowManager,
  CodeSummarizer,
  FilePager,
  RelevanceSelector,
  SlidingWindowContext,
  createContextManager,
  createSlidingWindow,
  estimateTokenCount,
  truncateToTokens,
  type ContextItem,
  type ContextWindow,
  type ContextSelectionOptions,
  type FileSummary,
} from './contextManager';

export interface AgentContext {
  userId: string;
  task: string;
  previousActions: string[];
  codeContext?: {
    files?: Array<{ path: string; content: string }>;
    focusedFile?: string;
    focusedFunction?: string;
  };
  screenState?: {
    activeApp: string | null;
    browserUrl: string;
    visibleWindows: string[];
  };
}

export interface LearnedInsight {
  type: 'pattern' | 'solution' | 'error_fix' | 'optimization' | 'fact' | 'concept';
  content: string;
  importance: number;
  entities?: string[];
  relations?: Array<{ target: string; type: string }>;
}

// Task classification using semantic analysis
export type TaskType = 
  | 'code_writing'
  | 'code_debugging'
  | 'code_refactoring'
  | 'code_review'
  | 'github_operation'
  | 'research'
  | 'memory_retrieval'
  | 'general';

interface TaskClassification {
  type: TaskType;
  confidence: number;
  relevantEntities: string[];
  suggestedApproach: string;
}

export class AgentBrain {
  private userId: string;
  private userMemory: ReturnType<typeof createUserMemory>;
  private codeExecutor: CodeExecutor;
  private testRunner: TestRunner;
  private github: GitHubIntegration;
  
  // Context management
  private contextManager: ContextWindowManager;
  private slidingWindow: SlidingWindowContext;
  private relevanceSelector: RelevanceSelector;
  private codeSummarizer: CodeSummarizer;
  private filePager: FilePager;
  
  constructor(userId: string) {
    this.userId = userId;
    this.userMemory = createUserMemory(userId);
    this.codeExecutor = new CodeExecutor(userId);
    this.testRunner = new TestRunner(userId);
    this.github = new GitHubIntegration(userId);
    
    // Initialize context management with configurable token limits
    this.contextManager = createContextManager(8000); // 8K token window by default
    this.slidingWindow = createSlidingWindow(4000, 500); // 4K tokens with 500 overlap
    this.relevanceSelector = new RelevanceSelector();
    this.codeSummarizer = new CodeSummarizer();
    this.filePager = new FilePager();
  }
  
  async think(context: AgentContext): Promise<{
    relevantMemories: string[];
    relevantSkills: string[];
    relevantKnowledgeNodes: any[];
    userPreferences: Record<string, unknown>;
    suggestedApproach: string;
    hierarchicalPlan?: string[];
    taskClassification: TaskClassification;
    codeAnalysis?: {
      entities: CodeEntity[];
      complexity: CodeAnalysisResult['complexity'];
      issues: CodeAnalysisResult['issues'];
    };
  }> {
    // Semantic task classification (replaces simple keyword matching)
    const taskClassification = this.classifyTask(context.task);
    
    // Analyze code context if provided
    let codeAnalysis: { entities: CodeEntity[]; complexity: CodeAnalysisResult['complexity']; issues: CodeAnalysisResult['issues'] } | undefined;
    if (context.codeContext?.files) {
      codeAnalyzer.clearCache();
      
      const analysisResults: CodeAnalysisResult[] = [];
      for (const file of context.codeContext.files) {
        const result = await codeAnalyzer.analyzeFile(file.path, file.content);
        analysisResults.push(result);
      }
      
      // Aggregate analysis results
      codeAnalysis = {
        entities: analysisResults.flatMap(r => r.entities),
        complexity: {
          cyclomaticComplexity: analysisResults.reduce((sum, r) => sum + r.complexity.cyclomaticComplexity, 0),
          linesOfCode: analysisResults.reduce((sum, r) => sum + r.complexity.linesOfCode, 0),
          functionCount: analysisResults.reduce((sum, r) => sum + r.complexity.functionCount, 0),
          classCount: analysisResults.reduce((sum, r) => sum + r.complexity.classCount, 0),
        },
        issues: analysisResults.flatMap(r => r.issues),
      };
      
      // Get dependency graph
      const depGraph = codeAnalyzer.getDependencyGraph();
      
      // Find entities related to the task by name matching
      const taskLower = context.task.toLowerCase();
      const taskEntities = codeAnalysis.entities.filter(e => 
        e.name.toLowerCase().includes(taskLower) || 
        taskLower.includes(e.name.toLowerCase())
      );
      taskClassification.relevantEntities = taskEntities.map(e => `${e.name} (${e.type}) at ${e.filePath}:${e.startLine}`);
    }
    
    const [universalMemories, userMemories, skills, preferences, graphNodes] = await Promise.all([
      agentMemory.searchUniversalMemory(context.task, 5),
      this.userMemory.searchMemories(context.task, 5),
      skillManager.searchSkills(context.task),
      this.userMemory.getAllPreferences(),
      knowledgeGraph.searchGraph(context.task),
    ]);
    
    const relevantMemories = [
      ...universalMemories.map(m => `[Universal] ${m.content}`),
      ...userMemories.map(m => `[User] ${m.content}`),
    ];
    
    const relevantSkills = [
      ...skills.map(s => `${s.skill_name}: ${s.description} (used ${s.usage_count}x, ${Math.round((s.success_rate || 0) * 100)}% success)`),
    ];

    // Expand context using Knowledge Graph
    const relevantKnowledgeNodes = [];
    for (const node of graphNodes) {
      const related = await knowledgeGraph.getRelatedNodes(node.id);
      relevantKnowledgeNodes.push({
        ...node,
        related: related.map(r => ({ type: r.relation, name: r.node.name }))
      });
    }
    
    // Use Hierarchical Planning (Tree of Thoughts) for complex tasks
    let hierarchicalPlan: string[] | undefined;
    const taskWords = context.task.toLowerCase().split(' ');
    if (context.task.length > 20 || taskWords.length > 4) {
      const taskContext = await this.getContextForTask(context.task, false);
      hierarchicalPlan = await hierarchicalPlanner.plan(context.task, {}, taskContext);
    }
    
    return {
      relevantMemories,
      relevantSkills,
      relevantKnowledgeNodes,
      userPreferences: preferences,
      suggestedApproach: taskClassification.suggestedApproach,
      hierarchicalPlan,
      taskClassification,
      codeAnalysis,
    };
  }

  /**
   * Semantic task classification using pattern matching and heuristics
   * Replaces simple keyword matching with more intelligent classification
   */
  private classifyTask(task: string): TaskClassification {
    const taskLower = task.toLowerCase();
    
    // Pattern-based classification with confidence scores
    const patterns: Array<{ type: TaskType; patterns: RegExp[]; approach: string }> = [
      {
        type: 'code_debugging',
        patterns: [
          /\b(fix|debug|error|bug|issue|crash|broken|not working|fails?|exception)\b/i,
          /\b(trace|stack|traceback|undefined|null|NaN)\b/i,
          /why (is|does|doesn't|isn't)/i,
        ],
        approach: 'Analyze error messages and stack traces. Use code analysis to trace the bug through call paths. Identify root cause before fixing.',
      },
      {
        type: 'code_refactoring',
        patterns: [
          /\b(refactor|clean|improve|optimize|restructure|reorganize|simplify)\b/i,
          /\b(performance|memory|speed|efficiency)\b/i,
          /make (it |this )?(better|faster|cleaner|more readable)/i,
        ],
        approach: 'Analyze code structure and dependencies. Identify code smells and anti-patterns. Plan incremental changes that preserve behavior.',
      },
      {
        type: 'code_review',
        patterns: [
          /\b(review|check|audit|analyze|examine|inspect|assess)\b/i,
          /\b(security|vulnerability|best practice|quality)\b/i,
          /what('s| is) wrong with/i,
        ],
        approach: 'Perform static analysis. Check for security vulnerabilities, code smells, and adherence to best practices. Provide actionable feedback.',
      },
      {
        type: 'code_writing',
        patterns: [
          /\b(write|create|implement|add|build|develop|make|generate)\b/i,
          /\b(function|class|component|module|api|endpoint|feature)\b/i,
          /\b(code|program|script|app|application)\b/i,
        ],
        approach: 'Understand requirements. Analyze existing code structure. Write code following project conventions and best practices.',
      },
      {
        type: 'github_operation',
        patterns: [
          /\b(github|git|repo|repository|branch|commit|push|pull|merge|pr|pull request)\b/i,
          /\b(clone|fork|release|deploy)\b/i,
        ],
        approach: 'Use GitHub integration. Check connection status first. Follow git workflow best practices.',
      },
      {
        type: 'research',
        patterns: [
          /\b(search|find|look for|browse|research|investigate)\b/i,
          /\b(documentation|docs|api|reference|example|tutorial)\b/i,
          /how (do|can|to|does)/i,
        ],
        approach: 'Search documentation and code examples. Gather relevant information before implementation.',
      },
      {
        type: 'memory_retrieval',
        patterns: [
          /\b(remember|recall|history|previous|last time|before)\b/i,
          /what (did|was|were)/i,
        ],
        approach: 'Search memories and past interactions for relevant context.',
      },
    ];

    let bestMatch: { type: TaskType; confidence: number; approach: string } = {
      type: 'general',
      confidence: 0.3,
      approach: 'Analyze the task and execute step by step.',
    };

    for (const { type, patterns: typePatterns, approach } of patterns) {
      let matchCount = 0;
      for (const pattern of typePatterns) {
        if (pattern.test(taskLower)) {
          matchCount++;
        }
      }
      
      if (matchCount > 0) {
        const confidence = Math.min(0.9, 0.4 + (matchCount * 0.2));
        if (confidence > bestMatch.confidence) {
          bestMatch = { type, confidence, approach };
        }
      }
    }

    return {
      type: bestMatch.type,
      confidence: bestMatch.confidence,
      relevantEntities: [],
      suggestedApproach: bestMatch.approach,
    };
  }
  
  async learn(insights: LearnedInsight[]): Promise<void> {
    for (const insight of insights) {
      const summary = summarizeForStorage(insight.content, 500);
      await agentMemory.addUniversalMemory(insight.type, summary, insight.importance);
      
      // Add to Knowledge Graph
      const nodeId = await knowledgeGraph.addNode(
        insight.entities?.[0] || insight.content.substring(0, 50),
        insight.type,
        insight.content,
        { importance: insight.importance, entities: insight.entities }
      );
      
      if (nodeId && insight.relations) {
        for (const rel of insight.relations) {
          const targetNode = await knowledgeGraph.findNodeByName(rel.target);
          if (targetNode) {
            await knowledgeGraph.addEdge(nodeId, targetNode.id, rel.type);
          }
        }
      }
    }
  }
  
  async learnFromTask(task: string, actions: string[], outcome: 'success' | 'failure', notes?: string): Promise<void> {
    const content = `Task: ${task}\nActions: ${actions.join(' → ')}\nOutcome: ${outcome}${notes ? `\nNotes: ${notes}` : ''}`;
    
    await this.userMemory.addMemory(
      'task_history',
      content,
      { task, actions, outcome },
      outcome === 'success' ? 0.7 : 0.5
    );

    // Add task to Knowledge Graph
    const taskId = await knowledgeGraph.addNode(task, 'task', content, { outcome, actions });
    
    if (outcome === 'success' && actions.length > 2) {
      // Auto-patch skill set (Continuous Learning 2.0)
      const patternName = `Skill: ${task.split(' ').slice(0, 3).join(' ')}`;
      await supabaseAdmin.from('skill_patterns').insert({
        pattern_name: patternName,
        pattern_description: `Generated from successful task: ${task}`,
        successful_action_sequence: actions,
        trigger_condition: task,
        usage_count: 1,
        success_rate: 1.0
      });

      const patternContent = `Successful pattern for "${task}": ${actions.join(' → ')}`;
      await agentMemory.addUniversalMemory('pattern', patternContent, 0.6);

      // Add solution to Knowledge Graph and link to task
      const solutionId = await knowledgeGraph.addNode(patternName, 'solution', patternContent, { actions });
      if (taskId && solutionId) {
        await knowledgeGraph.addEdge(taskId, solutionId, 'solved_by');
      }
    }
  }
  
  async learnNewSkill(
    name: string,
    category: 'coding' | 'research' | 'communication' | 'analysis' | 'automation' | 'integration',
    description: string,
    examples: string[],
    bestPractices: string[]
  ): Promise<void> {
    await skillManager.learnSkill(name, category, description, {
      examples,
      bestPractices,
      learnedAt: new Date().toISOString(),
    });
  }
  
  async monitorAndFixGitHubBuilds(owner: string, repo: string): Promise<{ fixed: boolean; message: string }> {
    await this.github.initialize();
    if (!this.github.isConnected()) {
      return { fixed: false, message: 'GitHub not connected' };
    }
    
    const result = await this.github.monitorAndFixBuilds(owner, repo);
    
    if (result.message.includes('Found failing build')) {
      await this.recordSkillUsage('github_cicd_monitoring', true);
      // Logic for autonomous fix would go here - for now we return the findings
    }
    
    return result;
  }
  
  async executeCode(language: string, code: string): Promise<{ success: boolean; output: string; error?: string }> {
    const result = await this.codeExecutor.execute(language, code);
    
    if (result.success) {
      await this.recordSkillUsage('code_execution', true);
    } else {
      await agentMemory.addUniversalMemory(
        'error_fix',
        `Error in ${language}: ${result.error}\nCode snippet: ${code.substring(0, 200)}`,
        0.4
      );
    }
    
    return result;
  }
  
  async runTests(language: string, code: string, testCode: string): Promise<{
    passed: number;
    failed: number;
    total: number;
    output: string;
  }> {
    const result = await this.testRunner.runTests(language, code, testCode);
    
    await this.recordSkillUsage('testing', result.failed === 0);
    
    return {
      passed: result.passed,
      failed: result.failed,
      total: result.total_tests,
      output: result.output || '',
    };
  }
  
  async connectGitHub(token: string): Promise<boolean> {
    const success = await this.github.initialize(token);
    if (success) {
      await this.recordSkillUsage('github_integration', true);
    }
    return success;
  }
  
  async getGitHubRepos(): Promise<Array<{ name: string; full_name: string; description: string | null }>> {
    await this.github.initialize();
    if (!this.github.isConnected()) return [];
    
    const repos = await this.github.listRepositories();
    return repos.map(r => ({
      name: r.name,
      full_name: r.full_name,
      description: r.description,
    }));
  }
  
  async createPR(
    owner: string,
    repo: string,
    title: string,
    head: string,
    base: string,
    body?: string
  ): Promise<{ success: boolean; prUrl?: string }> {
    await this.github.initialize();
    if (!this.github.isConnected()) {
      return { success: false };
    }
    
    const pr = await this.github.createPullRequest(owner, repo, title, head, base, body);
    if (pr) {
      await this.recordSkillUsage('pr_creation', true);
      return { success: true, prUrl: pr.html_url };
    }
    
    return { success: false };
  }
  
  async rememberUserPreference(key: string, value: unknown, context?: string): Promise<void> {
    await this.userMemory.setPreference(key, value, context);
  }
  
  async recallUserPreference(key: string): Promise<unknown | null> {
    return this.userMemory.getPreference(key);
  }
  
  async getContextForTask(task: string, includeRecursive: boolean = true): Promise<string> {
    const thinking = await this.think({ userId: this.userId, task, previousActions: [] });
    
    let context = '';
    
    if (thinking.relevantMemories.length > 0) {
      context += `\nRelevant memories:\n${thinking.relevantMemories.slice(0, 3).join('\n')}`;
    }
    
    if (thinking.relevantSkills.length > 0) {
      context += `\nRelevant skills:\n${thinking.relevantSkills.slice(0, 3).join('\n')}`;
    }
    
    if (Object.keys(thinking.userPreferences).length > 0) {
      context += `\nUser preferences: ${JSON.stringify(thinking.userPreferences)}`;
    }
    
    context += `\nSuggested approach: ${thinking.suggestedApproach}`;
    
    if (includeRecursive && thinking.hierarchicalPlan) {
      context += `\nHierarchical Plan (ToT):\n${thinking.hierarchicalPlan.join(' → ')}`;
    }
    
    return context;
  }
  
  async getMostUsedSkills(): Promise<Array<{ name: string; uses: number; successRate: number }>> {
    const skills = await skillManager.getMostUsedSkills(10);
    return skills.map(s => ({
      name: s.skill_name,
      uses: s.usage_count || 0,
      successRate: s.success_rate || 0,
    }));
  }
  
  async getAgentStats(): Promise<{
    totalSkills: number;
    totalMemories: number;
    topSkills: string[];
    recentLearnings: string[];
  }> {
    const [skills, memories] = await Promise.all([
      skillManager.getAllSkills(),
      agentMemory.getRecentMemories(5),
    ]);
    
    const sortedSkills = [...skills].sort((a, b) => (b.usage_count || 0) - (a.usage_count || 0));
    
    return {
      totalSkills: skills.length,
      totalMemories: memories.length,
      topSkills: sortedSkills.slice(0, 5).map(s => s.skill_name),
      recentLearnings: memories.map(m => m.content.substring(0, 100)),
    };
  }

  /**
   * Record skill usage for learning
   */
  private async recordSkillUsage(skillName: string, success: boolean): Promise<void> {
    await skillManager.useSkill(skillName, success);
  }

  // ============================================================
  // WORKSPACE & DOCKER METHODS
  // ============================================================

  /**
   * Mount a local project directory as the active workspace
   */
  async mountWorkspace(projectPath: string, name?: string): Promise<WorkspaceConfig | null> {
    try {
      const manager = await getWorkspaceManager();
      const workspace = await manager.mountLocalProject(projectPath, name);
      await manager.setActiveWorkspace(workspace.id);
      await this.recordSkillUsage('workspace_mount', true);
      return workspace;
    } catch (error) {
      console.error('Failed to mount workspace:', error);
      await this.recordSkillUsage('workspace_mount', false);
      return null;
    }
  }

  /**
   * Clone a git repository and set it as active workspace
   */
  async cloneAndMountRepo(gitUrl: string, name?: string, branch?: string): Promise<WorkspaceConfig | null> {
    try {
      const manager = await getWorkspaceManager();
      const workspace = await manager.cloneRepository(gitUrl, name, branch);
      await manager.setActiveWorkspace(workspace.id);
      await this.recordSkillUsage('workspace_clone', true);
      return workspace;
    } catch (error) {
      console.error('Failed to clone repository:', error);
      await this.recordSkillUsage('workspace_clone', false);
      return null;
    }
  }

  /**
   * Create a sandboxed Docker environment for safe code execution
   */
  async createDockerWorkspace(projectPath: string, options?: {
    name?: string;
    image?: string;
    ports?: Record<number, number>;
    installDeps?: boolean;
  }): Promise<DockerWorkspace | null> {
    try {
      const docker = await getDockerManager();
      if (!docker.isAvailable()) {
        console.warn('Docker is not available on this system');
        return null;
      }
      const workspace = await docker.createWorkspace(projectPath, options);
      docker.setActiveWorkspace(workspace.id);
      await this.recordSkillUsage('docker_workspace', true);
      return workspace;
    } catch (error) {
      console.error('Failed to create Docker workspace:', error);
      await this.recordSkillUsage('docker_workspace', false);
      return null;
    }
  }

  /**
   * Execute a command in the active workspace (Docker or local)
   */
  async executeInWorkspace(command: string, useDocker: boolean = false): Promise<{
    output: string;
    exitCode: number;
    isDocker: boolean;
  }> {
    try {
      if (useDocker) {
        const docker = await getDockerManager();
        const workspace = docker.getActiveWorkspace();
        if (workspace) {
          const result = await docker.execInContainer(workspace.containerId, command, workspace.workspaceDir);
          await this.recordSkillUsage('docker_exec', result.exitCode === 0);
          return { output: result.output, exitCode: result.exitCode, isDocker: true };
        }
      }

      // Fall back to workspace manager
      const manager = await getWorkspaceManager();
      const result = await manager.execInWorkspace(command);
      await this.recordSkillUsage('workspace_exec', result.exitCode === 0);
      return { output: result.stdout + result.stderr, exitCode: result.exitCode, isDocker: false };
    } catch (error: any) {
      return { output: error.message || 'Command failed', exitCode: 1, isDocker: false };
    }
  }

  /**
   * Run tests in the active workspace
   */
  async runWorkspaceTests(testCommand?: string, useDocker: boolean = false): Promise<{
    success: boolean;
    output: string;
    passed: number;
    failed: number;
    skipped: number;
  }> {
    try {
      if (useDocker) {
        const docker = await getDockerManager();
        const workspace = docker.getActiveWorkspace();
        if (workspace) {
          const result = await docker.runTests(workspace.id, testCommand);
          const summary = this.parseTestSummary(result.output);
          return { 
            success: result.exitCode === 0, 
            output: result.output, 
            ...summary 
          };
        }
      }

      const manager = await getWorkspaceManager();
      const result = await manager.runTests(testCommand);
      return {
        success: result.success,
        output: result.output,
        passed: result.summary.passed,
        failed: result.summary.failed,
        skipped: result.summary.skipped,
      };
    } catch (error: any) {
      return { success: false, output: error.message, passed: 0, failed: 0, skipped: 0 };
    }
  }

  /**
   * Run build in the active workspace
   */
  async runWorkspaceBuild(buildCommand?: string, useDocker: boolean = false): Promise<{
    success: boolean;
    output: string;
    errors: string[];
  }> {
    try {
      if (useDocker) {
        const docker = await getDockerManager();
        const workspace = docker.getActiveWorkspace();
        if (workspace) {
          const result = await docker.runBuild(workspace.id, buildCommand);
          const errors = this.parseBuildErrors(result.output);
          return { success: result.exitCode === 0, output: result.output, errors };
        }
      }

      const manager = await getWorkspaceManager();
      const result = await manager.runBuild(buildCommand);
      return result;
    } catch (error: any) {
      return { success: false, output: error.message, errors: [error.message] };
    }
  }

  /**
   * Read a file from the workspace
   */
  async readWorkspaceFile(filePath: string, useDocker: boolean = false): Promise<string | null> {
    try {
      if (useDocker) {
        const docker = await getDockerManager();
        const workspace = docker.getActiveWorkspace();
        if (workspace) {
          return await docker.readFile(workspace.containerId, filePath);
        }
      }

      const manager = await getWorkspaceManager();
      return await manager.readFile(filePath);
    } catch {
      return null;
    }
  }

  /**
   * Write a file to the workspace with versioning support
   */
  async writeWorkspaceFile(filePath: string, content: string, useDocker: boolean = false): Promise<boolean> {
    try {
      if (useDocker) {
        const docker = await getDockerManager();
        const workspace = docker.getActiveWorkspace();
        if (workspace) {
          await docker.writeFile(workspace.containerId, filePath, content);
          return true;
        }
      }

      const manager = await getWorkspaceManager();
      await manager.writeFile(filePath, content, true);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Rollback a file to a previous version
   */
  async rollbackWorkspaceFile(filePath: string, versionId: string): Promise<boolean> {
    try {
      const manager = await getWorkspaceManager();
      return await manager.rollbackFile(filePath, versionId);
    } catch {
      return false;
    }
  }

  /**
   * Get file version history
   */
  async getFileVersionHistory(filePath: string): Promise<Array<{
    id: string;
    timestamp: number;
    message?: string;
  }>> {
    try {
      const manager = await getWorkspaceManager();
      const versions = await manager.getFileVersions(filePath);
      return versions.map(v => ({
        id: v.id,
        timestamp: v.timestamp,
        message: v.commitMessage,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Git operations in workspace
   */
  async gitCommitWorkspace(message: string): Promise<string | null> {
    try {
      const manager = await getWorkspaceManager();
      return await manager.gitCommit(message);
    } catch {
      return null;
    }
  }

  async gitPushWorkspace(remote?: string, branch?: string): Promise<boolean> {
    try {
      const manager = await getWorkspaceManager();
      await manager.gitPush(remote, branch);
      return true;
    } catch {
      return false;
    }
  }

  async gitPullWorkspace(remote?: string, branch?: string): Promise<boolean> {
    try {
      const manager = await getWorkspaceManager();
      await manager.gitPull(remote, branch);
      return true;
    } catch {
      return false;
    }
  }

  async gitCreateBranch(branchName: string, checkout: boolean = true): Promise<boolean> {
    try {
      const manager = await getWorkspaceManager();
      await manager.gitCreateBranch(branchName, checkout);
      return true;
    } catch {
      return false;
    }
  }

  async getWorkspaceStatus(): Promise<{
    active: WorkspaceConfig | null;
    docker: DockerWorkspace | null;
    gitStatus: { staged: string[]; unstaged: string[]; untracked: string[] } | null;
  }> {
    try {
      const manager = await getWorkspaceManager();
      const docker = await getDockerManager();
      
      const activeWorkspace = manager.getActiveWorkspace();
      const activeDocker = docker.getActiveWorkspace();
      
      let gitStatus = null;
      if (activeWorkspace) {
        try {
          gitStatus = await manager.gitStatus();
        } catch {
          // Not a git repo
        }
      }

      return {
        active: activeWorkspace,
        docker: activeDocker,
        gitStatus,
      };
    } catch {
      return { active: null, docker: null, gitStatus: null };
    }
  }

  private parseTestSummary(output: string): { passed: number; failed: number; skipped: number } {
    let passed = 0, failed = 0, skipped = 0;
    
    // Jest/Vitest pattern
    const passedMatch = output.match(/(\d+)\s+pass(ed|ing)?/i);
    const failedMatch = output.match(/(\d+)\s+fail(ed|ing)?/i);
    const skippedMatch = output.match(/(\d+)\s+skip(ped)?/i);
    
    if (passedMatch) passed = parseInt(passedMatch[1]);
    if (failedMatch) failed = parseInt(failedMatch[1]);
    if (skippedMatch) skipped = parseInt(skippedMatch[1]);
    
    return { passed, failed, skipped };
  }

  private parseBuildErrors(output: string): string[] {
    const errors: string[] = [];
    const lines = output.split('\n');
    
    for (const line of lines) {
      if (line.match(/error(\s+TS\d+)?:/i) || line.match(/:\d+:\d+:\s*error:/)) {
        errors.push(line.trim());
      }
    }
    
    return errors;
  }

  // ============================================================
  // CODE ANALYSIS METHODS
  // ============================================================

  /**
   * Analyze code files and return structured analysis
   */
  async analyzeCode(files: Array<{ path: string; content: string }>): Promise<{
    entities: CodeEntity[];
    complexity: CodeAnalysisResult['complexity'];
    issues: CodeAnalysisResult['issues'];
    dependencyGraph: {
      nodes: string[];
      edges: Array<{ from: string; to: string }>;
      circularDependencies: string[][];
    };
    summary: {
      totalFiles: number;
      totalEntities: number;
      byType: Record<string, number>;
      avgComplexity: number;
    };
  }> {
    codeAnalyzer.clear();
    codeAnalyzer.addFiles(files);

    const results: CodeAnalysisResult[] = [];
    for (const file of files) {
      results.push(codeAnalyzer.analyzeFile(file.path));
    }

    const graph = codeAnalyzer.buildDependencyGraph();
    const circularDeps = codeAnalyzer.findCircularDependencies();
    const summary = codeAnalyzer.getCodebaseSummary();

    return {
      entities: results.flatMap(r => r.entities),
      complexity: {
        cyclomaticComplexity: results.reduce((sum, r) => sum + r.complexity.cyclomaticComplexity, 0),
        linesOfCode: results.reduce((sum, r) => sum + r.complexity.linesOfCode, 0),
        functionCount: results.reduce((sum, r) => sum + r.complexity.functionCount, 0),
        classCount: results.reduce((sum, r) => sum + r.complexity.classCount, 0),
      },
      issues: results.flatMap(r => r.issues),
      dependencyGraph: {
        nodes: Array.from(graph.nodes.keys()),
        edges: graph.edges.map(e => ({ from: e.from, to: e.to })),
        circularDependencies: circularDeps,
      },
      summary,
    };
  }

  /**
   * Find callers of a specific function
   */
  findFunctionCallers(functionName: string): CodeEntity[] {
    return codeAnalyzer.findCallers(functionName);
  }

  /**
   * Find what functions are called by a specific function
   */
  findFunctionCallees(functionName: string): string[] {
    return codeAnalyzer.findCallees(functionName);
  }

  /**
   * Search for code entities by pattern
   */
  searchCodeEntities(pattern: string, type?: CodeEntity['type']): CodeEntity[] {
    return codeAnalyzer.searchEntities(pattern, type);
  }

  /**
   * Get a specific entity by name
   */
  getCodeEntity(name: string): CodeEntity | null {
    return codeAnalyzer.getEntity(name);
  }

  /**
   * Get files that depend on a specific file
   */
  getFileDependents(filePath: string): string[] {
    return codeAnalyzer.getDependents(filePath);
  }

  /**
   * Get files that a specific file depends on
   */
  getFileDependencies(filePath: string): string[] {
    return codeAnalyzer.getDependencies(filePath);
  }

    /**
     * Analyze code for potential issues (security, performance, maintainability)
     */
    async reviewCode(files: Array<{ path: string; content: string }>): Promise<{
      issues: CodeAnalysisResult['issues'];
      suggestions: string[];
      complexity: CodeAnalysisResult['complexity'];
    }> {
      const analysis = await this.analyzeCode(files);
      const suggestions: string[] = [];

      // Generate suggestions based on analysis
      if (analysis.complexity.cyclomaticComplexity > 20) {
        suggestions.push('High cyclomatic complexity detected. Consider breaking down complex functions.');
      }

      const highComplexityFunctions = analysis.entities
        .filter(e => e.type === 'function' && e.complexity && e.complexity > 10);
      for (const fn of highComplexityFunctions) {
        suggestions.push(`Function "${fn.name}" has high complexity (${fn.complexity}). Consider refactoring.`);
      }

      if (analysis.dependencyGraph.circularDependencies.length > 0) {
        suggestions.push(`${analysis.dependencyGraph.circularDependencies.length} circular dependencies detected. This can cause maintainability issues.`);
      }

      const errorIssues = analysis.issues.filter(i => i.type === 'error');
      if (errorIssues.length > 0) {
        suggestions.push(`${errorIssues.length} error(s) found. These should be fixed before deployment.`);
      }

      return {
        issues: analysis.issues,
        suggestions,
        complexity: analysis.complexity,
      };
    }

    // ============================================================
    // DIFF-BASED EDITING METHODS
    // ============================================================

    /**
     * Apply a unified diff to file content
     * Surgical edit: preserves all lines except those in the diff
     */
    applyDiff(content: string, diffString: string): EditResult {
      return diffEditor.applyDiffString(content, diffString);
    }

    /**
     * Generate a diff between old and new content
     */
    generateDiff(oldContent: string, newContent: string, filePath: string): string {
      return DiffParser.generate(oldContent, newContent, filePath);
    }

    /**
     * Replace specific lines in content (surgical edit)
     * @param content - Original file content
     * @param startLine - First line to replace (1-indexed)
     * @param endLine - Last line to replace (1-indexed)
     * @param newContent - New content to insert
     */
    replaceLines(content: string, startLine: number, endLine: number, newContent: string): EditResult {
      return LineRangeEditor.replaceLines(content, startLine, endLine, newContent);
    }

    /**
     * Insert content after a specific line
     */
    insertAfterLine(content: string, line: number, newContent: string): EditResult {
      return LineRangeEditor.insertAfter(content, line, newContent);
    }

    /**
     * Insert content before a specific line
     */
    insertBeforeLine(content: string, line: number, newContent: string): EditResult {
      return LineRangeEditor.insertBefore(content, line, newContent);
    }

    /**
     * Delete a range of lines
     */
    deleteLines(content: string, startLine: number, endLine: number): EditResult {
      return LineRangeEditor.deleteLines(content, startLine, endLine);
    }

    /**
     * AST-aware modification (insert/modify/delete functions, classes, etc.)
     */
    astModify(content: string, filePath: string, modification: ASTModification): EditResult {
      return diffEditor.astModify(content, filePath, modification);
    }

    /**
     * Add a new function to a file
     */
    addFunction(content: string, filePath: string, functionCode: string, options?: {
      position?: 'before' | 'after' | 'start' | 'end';
      relativeTo?: string;
    }): EditResult {
      return diffEditor.addFunction(content, filePath, functionCode, options);
    }

    /**
     * Edit an existing function's body
     */
    editFunction(content: string, filePath: string, functionName: string, newBody: string): EditResult {
      return diffEditor.editFunction(content, filePath, functionName, newBody);
    }

    /**
     * Add an import statement
     */
    addImport(content: string, filePath: string, importStatement: string): EditResult {
      return diffEditor.addImport(content, filePath, importStatement);
    }

    /**
     * Delete a function, class, or variable by name
     */
    deleteEntity(content: string, filePath: string, entityName: string): EditResult {
      return diffEditor.deleteEntity(content, filePath, entityName);
    }

    /**
     * Rename a function, class, or variable
     */
    renameEntity(content: string, filePath: string, oldName: string, newName: string): EditResult {
      return diffEditor.renameEntity(content, filePath, oldName, newName);
    }

    /**
     * Add a method to a class
     */
    addMethod(content: string, filePath: string, className: string, methodCode: string): EditResult {
      return diffEditor.addMethod(content, filePath, className, methodCode);
    }

    /**
     * Wrap a function in try-catch
     */
    wrapInTryCatch(content: string, filePath: string, functionName: string): EditResult {
      return diffEditor.wrapInTryCatch(content, filePath, functionName);
    }

    /**
     * Validate code for syntax errors
     */
    validateCode(content: string, filePath: string): ValidationError[] {
      return diffEditor.validate(content, filePath);
    }

    /**
     * Check if code is syntactically valid
     */
    isCodeValid(content: string, filePath: string): boolean {
      return diffEditor.isSyntaxValid(content, filePath);
    }

    /**
     * Validate an edit before applying it
     */
    validateEdit(originalContent: string, editedContent: string, filePath: string): {
      valid: boolean;
      errors: ValidationError[];
      newErrors: ValidationError[];
    } {
      return diffEditor.validateEdit(originalContent, editedContent, filePath);
    }

    /**
     * Apply edits to multiple files atomically
     * If any file fails validation, no files are modified
     */
    async multiFileEdit(
      files: Map<string, string>,
      edits: MultiFileEdit,
      validate: boolean = true
    ): Promise<{
      success: boolean;
      results: Map<string, EditResult>;
      errors?: string[];
      rollbackAvailable: boolean;
    }> {
      const result = await diffEditor.multiFileEdit(files, edits, validate);
      
      if (result.success) {
        await this.recordSkillUsage('diff_editing', true);
      } else {
        await this.recordSkillUsage('diff_editing', false);
      }
      
      return result;
    }

    /**
     * Get backups for potential rollback
     */
    getEditBackups(): Map<string, string> {
      return diffEditor.getBackups();
    }

    /**
     * Edit a file in the workspace using diff-based editing
     */
    async editWorkspaceFile(
      filePath: string,
      edit: {
        type: 'diff' | 'replaceLines' | 'insertAfter' | 'insertBefore' | 'deleteLines' | 'ast';
        diff?: string;
        startLine?: number;
        endLine?: number;
        line?: number;
        content?: string;
        modification?: ASTModification;
      },
      useDocker: boolean = false
    ): Promise<EditResult & { diff?: string }> {
      // Read the file
      const currentContent = await this.readWorkspaceFile(filePath, useDocker);
      if (currentContent === null) {
        return { success: false, error: 'File not found' };
      }

      let result: EditResult;

      // Apply the edit based on type
      switch (edit.type) {
        case 'diff':
          if (!edit.diff) return { success: false, error: 'diff is required' };
          result = this.applyDiff(currentContent, edit.diff);
          break;

        case 'replaceLines':
          if (!edit.startLine || !edit.endLine || edit.content === undefined) {
            return { success: false, error: 'startLine, endLine, and content are required' };
          }
          result = this.replaceLines(currentContent, edit.startLine, edit.endLine, edit.content);
          break;

        case 'insertAfter':
          if (!edit.line || edit.content === undefined) {
            return { success: false, error: 'line and content are required' };
          }
          result = this.insertAfterLine(currentContent, edit.line, edit.content);
          break;

        case 'insertBefore':
          if (!edit.line || edit.content === undefined) {
            return { success: false, error: 'line and content are required' };
          }
          result = this.insertBeforeLine(currentContent, edit.line, edit.content);
          break;

        case 'deleteLines':
          if (!edit.startLine || !edit.endLine) {
            return { success: false, error: 'startLine and endLine are required' };
          }
          result = this.deleteLines(currentContent, edit.startLine, edit.endLine);
          break;

        case 'ast':
          if (!edit.modification) {
            return { success: false, error: 'modification is required' };
          }
          result = this.astModify(currentContent, filePath, edit.modification);
          break;

        default:
          return { success: false, error: `Unknown edit type: ${edit.type}` };
      }

      if (!result.success) {
        return result;
      }

      // Validate the edit if it's a TypeScript/JavaScript file
      if (filePath.match(/\.(ts|tsx|js|jsx)$/)) {
        const validation = this.validateEdit(currentContent, result.content!, filePath);
        if (!validation.valid) {
          return {
            success: false,
            error: 'Edit validation failed',
            validationErrors: validation.newErrors,
          };
        }
      }

      // Write the file
      const writeSuccess = await this.writeWorkspaceFile(filePath, result.content!, useDocker);
      if (!writeSuccess) {
        return { success: false, error: 'Failed to write file' };
      }

      // Generate diff for response
      const diffOutput = this.generateDiff(currentContent, result.content!, filePath);

      await this.recordSkillUsage('diff_editing', true);

      return {
        success: true,
        content: result.content,
        diff: diffOutput,
      };
    }

    /**
     * Preview an edit without applying it
     */
    previewEdit(
      content: string,
      filePath: string,
      edit: {
        type: 'diff' | 'replaceLines' | 'insertAfter' | 'insertBefore' | 'deleteLines' | 'ast';
        diff?: string;
        startLine?: number;
        endLine?: number;
        line?: number;
        content?: string;
        modification?: ASTModification;
      }
    ): { result: EditResult; diff: string; validation: { valid: boolean; errors: ValidationError[] } } {
      let result: EditResult;

      switch (edit.type) {
        case 'diff':
          result = this.applyDiff(content, edit.diff || '');
          break;
        case 'replaceLines':
          result = this.replaceLines(content, edit.startLine || 0, edit.endLine || 0, edit.content || '');
          break;
        case 'insertAfter':
          result = this.insertAfterLine(content, edit.line || 0, edit.content || '');
          break;
        case 'insertBefore':
          result = this.insertBeforeLine(content, edit.line || 0, edit.content || '');
          break;
        case 'deleteLines':
          result = this.deleteLines(content, edit.startLine || 0, edit.endLine || 0);
          break;
        case 'ast':
          result = this.astModify(content, filePath, edit.modification!);
          break;
        default:
          result = { success: false, error: `Unknown edit type` };
      }

      const diff = result.success 
        ? this.generateDiff(content, result.content!, filePath) 
        : '';
      
      const validation = result.success
        ? this.validateEdit(content, result.content!, filePath)
        : { valid: false, errors: [], newErrors: [] };

      return {
        result,
        diff,
        validation: {
          valid: validation.valid,
          errors: validation.newErrors,
        },
      };
    }

    // ============================================================
    // CONTEXT WINDOW MANAGEMENT METHODS
    // ============================================================

    /**
     * Add a code file to the context with intelligent summarization
     * Automatically determines detail level based on file size and relevance
     */
    async addCodeFileToContext(
      filePath: string,
      content: string,
      relevanceScore: number = 0.5,
      preferSummary: boolean = true
    ): Promise<string> {
      return this.contextManager.addCodeFile(filePath, content, relevanceScore, preferSummary);
    }

    /**
     * Add a specific code entity (function, class, etc.) to context
     */
    async addCodeEntityToContext(
      filePath: string,
      content: string,
      entityName: string,
      relevanceScore: number = 0.7
    ): Promise<string | null> {
      return this.contextManager.addCodeEntity(filePath, content, entityName, relevanceScore);
    }

    /**
     * Add conversation to the sliding window context
     */
    addConversationToContext(content: string, relevanceScore: number = 0.6): string {
      this.slidingWindow.add(content); // Also add to sliding window for history
      return this.contextManager.addConversation(content, relevanceScore);
    }

    /**
     * Add memory to context
     */
    addMemoryToContext(content: string, source: string, relevanceScore: number = 0.5): string {
      return this.contextManager.addMemory(content, source, relevanceScore);
    }

    /**
     * Add current task to context with high priority
     */
    addTaskToContext(content: string, relevanceScore: number = 0.9): string {
      return this.contextManager.addTask(content, relevanceScore);
    }

    /**
     * Build optimized context for LLM prompt
     * Returns context string optimized for token limit
     */
    buildOptimizedContext(options?: Partial<ContextSelectionOptions>): {
      contextString: string;
      tokenCount: number;
      itemCount: number;
      usedPercentage: number;
    } {
      const defaultOptions: ContextSelectionOptions = {
        maxTokens: 8000,
        preferSummaries: true,
        priorityWeights: {
          recency: 0.2,
          relevance: 0.6,
          importance: 0.2,
        },
        ...options,
      };

      const window = this.contextManager.buildContext(defaultOptions);
      const contextString = this.contextManager.buildContextString(window);

      return {
        contextString,
        tokenCount: window.totalTokens,
        itemCount: window.items.length,
        usedPercentage: window.usedPercentage,
      };
    }

    /**
     * Select most relevant context items for a specific query
     * Uses semantic similarity with embeddings
     */
    async selectRelevantContext(
      query: string,
      maxTokens: number = 4000,
      minScore: number = 0.5
    ): Promise<ContextItem[]> {
      const allItems = Array.from(this.contextManager['items'].values());
      return this.relevanceSelector.selectRelevant(allItems, query, maxTokens, minScore);
    }

    /**
     * Get hierarchical summary of a code file
     */
    async summarizeCodeFile(filePath: string, content: string): Promise<FileSummary> {
      return this.codeSummarizer.summarizeFile(filePath, content);
    }

    /**
     * Get code at specific detail level
     * Level 1: Just summary
     * Level 2: Summary + signatures
     * Level 3: Summary + key function bodies
     * Level 4: Full content
     */
    async getCodeAtDetailLevel(
      filePath: string,
      content: string,
      level: 1 | 2 | 3 | 4,
      keyEntities?: string[]
    ): Promise<string> {
      const summary = await this.codeSummarizer.summarizeFile(filePath, content);
      return this.codeSummarizer.getAtDetailLevel(summary, level, keyEntities);
    }

    /**
     * Load a large file for paging
     */
    loadFileForPaging(filePath: string, content: string, pageSize: number = 100): {
      totalLines: number;
      totalPages: number;
      pageSize: number;
    } {
      const pagedFile = this.filePager.loadFile(filePath, content, pageSize);
      return {
        totalLines: pagedFile.totalLines,
        totalPages: pagedFile.totalPages,
        pageSize: pagedFile.pageSize,
      };
    }

    /**
     * Get a specific page from a large file
     */
    getFilePage(filePath: string, pageNumber: number): string | null {
      return this.filePager.getPage(filePath, pageNumber);
    }

    /**
     * Get page containing a specific line
     */
    getFilePageForLine(filePath: string, lineNumber: number): { page: number; content: string } | null {
      return this.filePager.getPageForLine(filePath, lineNumber);
    }

    /**
     * Get a range of lines from a file
     */
    getFileLineRange(filePath: string, startLine: number, endLine: number): string | null {
      return this.filePager.getLineRange(filePath, startLine, endLine);
    }

    /**
     * Get current sliding window content
     */
    getSlidingWindowContent(): string {
      return this.slidingWindow.getContent();
    }

    /**
     * Get sliding window token usage
     */
    getSlidingWindowTokens(): number {
      return this.slidingWindow.getTotalTokens();
    }

    /**
     * Clear the sliding window
     */
    clearSlidingWindow(): void {
      this.slidingWindow.clear();
    }

    /**
     * Get context statistics
     */
    getContextStats(): {
      itemCount: number;
      totalTokens: number;
      byType: Record<string, { count: number; tokens: number }>;
      slidingWindowTokens: number;
    } {
      const stats = this.contextManager.getStats();
      return {
        ...stats,
        slidingWindowTokens: this.slidingWindow.getTotalTokens(),
      };
    }

    /**
     * Clear all context
     */
    clearAllContext(): void {
      this.contextManager.clear();
      this.slidingWindow.clear();
      this.relevanceSelector.clearCache();
      this.codeSummarizer.clearCache();
      this.filePager.clear();
    }

    /**
     * Clear context older than specified age
     */
    clearOldContext(maxAgeMs: number = 3600000): number {
      return this.contextManager.clearOlderThan(maxAgeMs);
    }

    /**
     * Estimate token count for text
     */
    estimateTokens(text: string): number {
      return estimateTokenCount(text);
    }

    /**
     * Truncate text to token limit
     */
    truncateToTokenLimit(text: string, maxTokens: number): string {
      return truncateToTokens(text, maxTokens);
    }

    /**
     * Get enhanced context for task execution
     * Combines memories, skills, and code context with intelligent prioritization
     */
    async getEnhancedTaskContext(
      task: string,
      codeFiles?: Array<{ path: string; content: string }>,
      maxTokens: number = 6000
    ): Promise<string> {
      // Clear old context first
      this.clearOldContext(1800000); // 30 minutes

      // Add task with high priority
      this.addTaskToContext(task, 0.95);

      // Add code files with automatic summarization
      if (codeFiles) {
        for (const file of codeFiles) {
          // Calculate relevance based on task keywords
          const taskLower = task.toLowerCase();
          const pathLower = file.path.toLowerCase();
          const relevance = pathLower.includes(taskLower) || taskLower.includes(pathLower.split('/').pop()?.split('.')[0] || '')
            ? 0.85
            : 0.5;
          
          await this.addCodeFileToContext(file.path, file.content, relevance, true);
        }
      }

      // Get memories and add to context
      const memories = await agentMemory.searchUniversalMemory(task, 5);
      for (const memory of memories) {
        this.addMemoryToContext(memory.content, `memory:${memory.type}`, memory.similarity || 0.5);
      }

      // Get relevant skills
      const skills = await skillManager.searchSkills(task);
      for (const skill of skills.slice(0, 3)) {
        this.addMemoryToContext(
          `Skill: ${skill.skill_name} - ${skill.description}`,
          `skill:${skill.skill_name}`,
          0.6
        );
      }

      // Build optimized context
      const { contextString } = this.buildOptimizedContext({ maxTokens });
      
      return contextString;
    }
}

export function createAgentBrain(userId: string): AgentBrain {
  return new AgentBrain(userId);
}

export async function initializeBaseSkills(): Promise<void> {
  const baseSkills = [
    {
      name: 'web_browsing',
      category: 'research' as const,
      description: 'Navigate websites, search for information, and extract data from web pages',
      knowledge: { patterns: ['NAVIGATE:url', 'TYPE:search_query', 'CLICK:element'] },
    },
    {
      name: 'code_execution',
      category: 'coding' as const,
      description: 'Write and execute code in multiple programming languages',
      knowledge: { languages: ['javascript', 'python', 'typescript'], patterns: ['write', 'test', 'debug'] },
    },
    {
      name: 'github_integration',
      category: 'integration' as const,
      description: 'Interact with GitHub repositories, create branches, and manage pull requests',
      knowledge: { actions: ['clone', 'branch', 'commit', 'push', 'pr'] },
    },
    {
      name: 'testing',
      category: 'coding' as const,
      description: 'Write and run automated tests for code',
      knowledge: { frameworks: ['jest', 'unittest', 'pytest'] },
    },
    {
      name: 'task_planning',
      category: 'analysis' as const,
      description: 'Break down complex tasks into manageable steps',
      knowledge: { patterns: ['analyze', 'plan', 'execute', 'verify'] },
    },
    {
      name: 'workspace_mount',
      category: 'integration' as const,
      description: 'Mount local project directories as active workspace for file operations',
      knowledge: { actions: ['mount', 'unmount', 'switch'], supported: ['local', 'git-clone', 'git-worktree'] },
    },
    {
      name: 'workspace_clone',
      category: 'integration' as const,
      description: 'Clone git repositories and set them as active workspace',
      knowledge: { actions: ['clone', 'checkout', 'branch'], vcs: ['git'] },
    },
    {
      name: 'docker_workspace',
      category: 'automation' as const,
      description: 'Create sandboxed Docker environments for safe code execution and testing',
      knowledge: { images: ['node', 'python', 'go', 'rust'], actions: ['create', 'exec', 'test', 'build'] },
    },
    {
      name: 'workspace_exec',
      category: 'automation' as const,
      description: 'Execute commands in the active workspace context',
      knowledge: { patterns: ['shell', 'npm', 'python', 'make'] },
    },
      {
        name: 'docker_exec',
        category: 'automation' as const,
        description: 'Execute commands inside Docker containers for isolated execution',
        knowledge: { patterns: ['shell', 'test', 'build', 'install'] },
      },
      {
        name: 'diff_editing',
        category: 'coding' as const,
        description: 'Surgical code editing using unified diffs, line-range operations, and AST-aware modifications',
        knowledge: { 
          operations: ['applyDiff', 'replaceLines', 'insertAfter', 'insertBefore', 'deleteLines', 'astModify'],
          astOperations: ['insertFunction', 'insertClass', 'insertMethod', 'insertImport', 'modifyFunction', 'deleteEntity', 'renameEntity'],
          features: ['validation', 'multiFile', 'atomicCommit', 'rollback']
        },
      },
    ];
  
  for (const skill of baseSkills) {
    await skillManager.learnSkill(skill.name, skill.category, skill.description, skill.knowledge);
  }
}
