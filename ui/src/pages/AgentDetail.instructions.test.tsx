// @vitest-environment jsdom

import type { ComponentProps } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent, AgentInstructionsBundle, AgentInstructionsFileDetail, AgentInstructionsFileSummary } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { AgentFileRunNotice, PromptsTab } from "./AgentDetail";
import { queryKeys } from "../lib/queryKeys";
import { ApiError } from "../api/client";

const mockAgentsApi = vi.hoisted(() => ({
  instructionsBundle: vi.fn(),
  instructionsFile: vi.fn(),
  updateInstructionsBundle: vi.fn(),
  saveInstructionsFile: vi.fn(),
  deleteInstructionsFile: vi.fn(),
  instructionHistory: vi.fn(),
  instructionCandidates: vi.fn(),
  resolveInstructionCandidate: vi.fn(),
  instructionDiff: vi.fn(),
  restoreInstructions: vi.fn(),
  downloadInstructionsFile: vi.fn(),
}));

const markdownEditorRenderMock = vi.hoisted(() => vi.fn());
const copyTextToClipboardMock = vi.hoisted(() => vi.fn(async (_text: string) => {}));

vi.mock("../lib/clipboard", () => ({ copyTextToClipboard: copyTextToClipboardMock }));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

vi.mock("../api/assets", () => ({
  assetsApi: {
    uploadImage: vi.fn(async () => ({ contentPath: "/assets/uploaded-image.png" })),
  },
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: false }),
}));

vi.mock("@/adapters/use-adapter-capabilities", () => ({
  useAdapterCapabilities: () => () => ({
    supportsInstructionsBundle: true,
    supportsSkills: true,
    supportsLocalAgentJwt: true,
    requiresMaterializedRuntimeSkills: false,
  }),
}));

vi.mock("../components/MarkdownEditor", () => ({
  MarkdownEditor: ({
    value,
    onChange,
    placeholder,
    contentClassName,
    imageUploadHandler,
  }: {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    contentClassName?: string;
    imageUploadHandler?: (file: File) => Promise<string>;
  }) => {
    markdownEditorRenderMock({
      value,
      onChange,
      contentClassName,
      hasImageUploadHandler: Boolean(imageUploadHandler),
    });
    return (
      <textarea
        data-testid="markdown-editor"
        aria-label="Markdown editor"
        className={contentClassName}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  },
}));

vi.mock("../components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: string }) => <div data-testid="markdown-body">{children}</div>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function waitFor<T>(assertion: () => T): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < 20; i++) {
    try {
      return assertion();
    } catch (error) {
      lastError = error;
      await flushReact();
    }
  }
  throw lastError;
}

function setNativeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

function buttonByText(container: HTMLElement, text: string) {
  const button = Array.from(container.querySelectorAll("button"))
    .find((candidate) => candidate.textContent?.trim() === text);
  if (!button) throw new Error(`Button not found: ${text}`);
  return button as HTMLButtonElement;
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Codex Coder",
    urlKey: "codexcoder",
    role: "engineer",
    title: null,
    icon: null,
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function makeSummary(
  path: string,
  entryFile: string,
  overrides: Partial<AgentInstructionsFileSummary> = {},
): AgentInstructionsFileSummary {
  const markdown = path.toLowerCase().endsWith(".md");
  return {
    path,
    size: 24,
    language: markdown ? "markdown" : "text",
    markdown,
    isEntryFile: path === entryFile,
    editable: true,
    deprecated: false,
    virtual: false,
    ...overrides,
  };
}

function makeDetail(
  summary: AgentInstructionsFileSummary,
  content = "# Agent instructions",
  overrides: Partial<AgentInstructionsFileDetail> = {},
): AgentInstructionsFileDetail {
  return {
    ...summary,
    content,
    ...overrides,
  };
}

function makeBundle(
  entryFile: string,
  files: AgentInstructionsFileSummary[],
  overrides: Partial<AgentInstructionsBundle> = {},
): AgentInstructionsBundle {
  return {
    agentId: "agent-1",
    companyId: "company-1",
    mode: "managed",
    rootPath: "/paperclip/agents/agent-1/instructions",
    managedRootPath: "/paperclip/agents/agent-1/instructions",
    entryFile,
    resolvedEntryPath: `/paperclip/agents/agent-1/instructions/${entryFile}`,
    editable: true,
    warnings: [],
    legacyPromptTemplateActive: false,
    legacyBootstrapPromptTemplateActive: false,
    files,
    ...overrides,
  };
}

describe("PromptsTab instruction editor", () => {
  let container: HTMLDivElement;
  let root: Root | null;
  let queryClient: QueryClient;
  let saveAction: (() => void) | null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    saveAction = null;
    markdownEditorRenderMock.mockClear();
    Object.values(mockAgentsApi).forEach((mock) => mock.mockReset());
    mockAgentsApi.instructionCandidates.mockResolvedValue([]);
    mockAgentsApi.updateInstructionsBundle.mockResolvedValue({});
    mockAgentsApi.saveInstructionsFile.mockImplementation(async (_agentId, data) => ({
      path: data.path,
      size: data.content.length,
      language: "markdown",
      markdown: true,
      isEntryFile: true,
      editable: true,
      deprecated: false,
      virtual: false,
      content: data.content,
    }));
    mockAgentsApi.deleteInstructionsFile.mockResolvedValue({});
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
    }
    queryClient.clear();
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function renderPromptsTab(
    bundle: AgentInstructionsBundle,
    details: Record<string, AgentInstructionsFileDetail>,
    props: Partial<ComponentProps<typeof PromptsTab>> = {},
  ) {
    mockAgentsApi.instructionsBundle.mockResolvedValue(bundle);
    mockAgentsApi.instructionsFile.mockImplementation(async (_agentId: string, path: string) => {
      const detail = details[path];
      if (!detail) throw new Error(`Missing detail for ${path}`);
      return detail;
    });

    root = createRoot(container);
    await act(async () => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <PromptsTab
            agent={props.agent ?? makeAgent()}
            companyId={props.companyId ?? "company-1"}
            onDirtyChange={props.onDirtyChange ?? vi.fn()}
            onSaveActionChange={props.onSaveActionChange ?? ((next) => { saveAction = next; })}
            onCancelActionChange={props.onCancelActionChange ?? vi.fn()}
            onSavingChange={props.onSavingChange ?? vi.fn()}
          />
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  async function selectInstructionMode(mode: "Read" | "Edit" | "Raw") {
    await act(async () => {
      buttonByText(container, mode.toLowerCase()).click();
    });
    await flushReact();
  }

  it("uses server markdown metadata for extensionless files and saves MarkdownEditor drafts", async () => {
    const summary = makeSummary("AGENTS", "AGENTS", {
      language: "markdown",
      markdown: true,
    });
    await renderPromptsTab(
      makeBundle("AGENTS", [summary]),
      { AGENTS: makeDetail(summary, "# Current") },
    );

    await waitFor(() => {
      expect(container.querySelector('[data-testid="markdown-body"]')?.textContent).toBe("# Current");
    });
    await selectInstructionMode("Raw");
    expect(container.querySelector('[data-testid="instructions-raw-source"]')?.textContent?.trim()).toBe("# Current");
    await selectInstructionMode("Edit");

    const editor = await waitFor(() => {
      const candidate = container.querySelector<HTMLTextAreaElement>('[data-testid="markdown-editor"]');
      expect(candidate).not.toBeNull();
      return candidate!;
    });
    expect(markdownEditorRenderMock).toHaveBeenLastCalledWith(expect.objectContaining({
      contentClassName: expect.not.stringContaining("font-mono"),
      hasImageUploadHandler: true,
      value: "# Current",
    }));

    await act(async () => {
      editor.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      setNativeValue(editor, "# Updated");
    });
    await waitFor(() => {
      expect(saveAction).toEqual(expect.any(Function));
    });

    saveAction?.();
    await waitFor(() => {
      expect(mockAgentsApi.saveInstructionsFile).toHaveBeenCalledWith(
        "agent-1",
        {
          path: "AGENTS",
          content: "# Updated",
          baseRevisionId: null,
          clearLegacyPromptTemplate: false,
        },
        "company-1",
      );
    });
  });

  it("loads preserved edits against the displayed head and retains their pinned base after a conflict", async () => {
    const summary = makeSummary("AGENTS.md", "AGENTS.md");
    const revision = { id: "head-1", entryFile: "AGENTS.md" } as NonNullable<AgentInstructionsFileDetail["revision"]>;
    mockAgentsApi.instructionCandidates.mockResolvedValue([{ runId: "preserved-run", entryFile: "AGENTS.md", baseRevisionId: "older-base", baseHash: "base-hash", state: "conflict", candidateHash: "candidate-hash", content: "preserved edit", errorCode: "INSTRUCTION_REVISION_CONFLICT", errorMessage: "Instructions changed", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }]);
    await renderPromptsTab(makeBundle("AGENTS.md", [summary]), { "AGENTS.md": makeDetail(summary, "current content", { revision }) });
    await waitFor(() => expect(buttonByText(container, "Review preserved edits")).toBeDefined());
    await act(async () => { buttonByText(container, "Review preserved edits").click(); });
    const editor = await waitFor(() => {
      const element = container.querySelector<HTMLTextAreaElement>('[data-testid="markdown-editor"]');
      expect(element?.value).toBe("preserved edit"); return element!;
    });
    mockAgentsApi.resolveInstructionCandidate.mockRejectedValue(new Error("Instructions changed since the base revision"));
    await waitFor(() => expect(saveAction).toEqual(expect.any(Function)));
    await act(async () => { saveAction?.(); });
    await waitFor(() => expect(mockAgentsApi.resolveInstructionCandidate).toHaveBeenCalledWith("agent-1", "preserved-run", { content: "preserved edit", baseRevisionId: "head-1" }, "company-1"));
    expect(mockAgentsApi.saveInstructionsFile).not.toHaveBeenCalled();
    expect(editor.value).toBe("preserved edit");
    await act(async () => { queryClient.setQueryData(["agents", "instructions-bundle", "agent-1", "file", "AGENTS.md"], makeDetail(summary, "newer content", { revision: { ...revision, id: "head-2" } })); });
    await act(async () => { saveAction?.(); });
    await waitFor(() => expect(mockAgentsApi.resolveInstructionCandidate).toHaveBeenCalledTimes(2));
    expect(mockAgentsApi.resolveInstructionCandidate.mock.lastCall?.[2].baseRevisionId).toBe("head-1");
    expect(editor.value).toBe("preserved edit");
    mockAgentsApi.instructionsFile.mockResolvedValue(makeDetail(summary, "latest content", { revision: { ...revision, id: "head-3" } }));
    await waitFor(() => expect(buttonByText(container, "Refresh current revision").disabled).toBe(false));
    await act(async () => { buttonByText(container, "Refresh current revision").click(); });
    await waitFor(() => expect(container.textContent).toContain("latest content"));
    expect(editor.value).toBe("preserved edit");
    expect(mockAgentsApi.resolveInstructionCandidate).toHaveBeenCalledTimes(2);
    await act(async () => { saveAction?.(); });
    await waitFor(() => expect(mockAgentsApi.resolveInstructionCandidate).toHaveBeenCalledTimes(3));
    expect(mockAgentsApi.resolveInstructionCandidate.mock.lastCall?.[2].baseRevisionId).toBe("head-3");
  });

  it("keeps historical whole-folder failures out of the current editor while preserving legacy review", async () => {
    const summary = makeSummary("AGENTS.md", "AGENTS.md");
    const failures = [1, 2, 3].map(attempt => ({ contract: "agent_files", runId: `failed-auth-${attempt}`,
      entryFile: "AGENTS.md", state: "unavailable", content: null,
      errorMessage: "The registered instruction copy could not be retrieved safely before environment release. No instruction save is claimed." }));
    mockAgentsApi.instructionCandidates.mockResolvedValue(failures);
    await renderPromptsTab(makeBundle("AGENTS.md", [summary], { persistence: "agent_files" }), {
      "AGENTS.md": makeDetail(summary, "Successfully saved agent instructions"),
    });
    await waitFor(() => expect(container.textContent).toContain("Successfully saved agent instructions"));
    expect(container.textContent).not.toContain("could not be retrieved");
    expect(container.textContent).not.toContain("Preserved instruction edits");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await act(async () => {
      queryClient.setQueryData(queryKeys.agents.instructionCandidates("agent-1"), [...failures, {
        contract: "legacy", runId: "preserved-run", entryFile: "AGENTS.md", state: "conflict",
        content: "Legacy edits to review", createdAt: "2026-01-01T00:00:00Z",
      }]);
    });
    await waitFor(() => expect(buttonByText(container, "Review preserved edits").disabled).toBe(false));
    expect(container.textContent).toContain("Preserved instruction edits");
    expect(container.textContent).not.toContain("could not be retrieved");
  });

  it("scopes sync warnings to the affected run and displays a storage warning only once", async () => {
    root = createRoot(container);
    const render = async (instructionSave: Record<string, unknown>) => act(async () => {
      root?.render(<AgentFileRunNotice resultJson={{ instructionSave }} />);
    });
    await render({ contract: "agent_files", state: "unavailable", errorMessage: "This run's files were not saved." });
    expect(container.textContent).toContain("Agent file sync failed for this run");
    expect(container.textContent).toContain("This run's files were not saved.");
    await render({ contract: "agent_files", state: "unavailable", errorCode: "AGENT_FILES_LIMIT_EXCEEDED", errorMessage: "Save rejected", storageWarning: "Agent storage is full. Runs can continue." });
    expect(container.querySelectorAll('[role="note"]')).toHaveLength(1);
    expect(container.textContent).toContain("Runs can continue");
    expect(container.textContent).not.toContain("Save rejected");
    await render({ contract: "agent_files", state: "unavailable", errorCode: "AGENT_FILES_SAVE_FAILED", errorMessage: "An I/O failure prevented saving this run's files.", storageWarning: "Agent storage is full. Runs can continue." });
    expect(container.querySelectorAll('[role="note"]')).toHaveLength(2);
    expect(container.textContent).toContain("Runs can continue");
    expect(container.textContent).toContain("An I/O failure prevented saving this run's files.");
    await render({ contract: "agent_files", state: "saved" });
    expect(container.textContent).toBe("");
    await render({ state: "conflict", errorMessage: "Legacy candidate needs review" });
    expect(container.textContent).toBe("");
  });

  it("keeps changed-entry preserved edits readable and copyable without enabling a save", async () => {
    const summary = makeSummary("CURRENT.md", "CURRENT.md");
    const revision = { id: "current-head", entryFile: "CURRENT.md" } as NonNullable<AgentInstructionsFileDetail["revision"]>;
    const preserved = "# Original entry\nPreserve these exact edits.\n";
    mockAgentsApi.instructionCandidates.mockResolvedValue([{ runId: "old-entry-run", entryFile: "OLD.md", baseRevisionId: "old-head", baseHash: "base-hash", state: "conflict", candidateHash: "candidate-hash", content: preserved, errorCode: "INSTRUCTION_ENTRY_CHANGED", errorMessage: "The instruction entry changed", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }]);
    await renderPromptsTab(makeBundle("CURRENT.md", [summary]), { "CURRENT.md": makeDetail(summary, "Current instructions", { revision }) });
    await waitFor(() => expect(buttonByText(container, "Review preserved edits").disabled).toBe(false));
    await act(async () => { buttonByText(container, "Review preserved edits").click(); });
    const review = await waitFor(() => {
      const region = container.querySelector<HTMLElement>('[aria-label="Preserved edits for OLD.md"]');
      expect(region?.querySelector("pre")?.textContent).toBe(preserved);
      return region!;
    });
    expect(review.textContent).toContain("Read only");
    expect(review.textContent).toContain("CURRENT.md");
    expect(review.querySelector("textarea, input, [contenteditable=true]")).toBeNull();
    expect(saveAction).toBeNull();
    expect(mockAgentsApi.instructionsFile.mock.calls.every((call) => call[1] === "CURRENT.md")).toBe(true);
    await act(async () => { review.querySelector<HTMLButtonElement>('[aria-label="Copy preserved edits for OLD.md"]')!.click(); });
    expect(copyTextToClipboardMock).toHaveBeenCalledWith(preserved);
    expect(saveAction).toBeNull();
    expect(mockAgentsApi.resolveInstructionCandidate).not.toHaveBeenCalled();
    expect(mockAgentsApi.saveInstructionsFile).not.toHaveBeenCalled();

    // Choosing to edit and paste into the current entry is a separate ordinary save.
    await selectInstructionMode("Edit");
    const editor = container.querySelector<HTMLTextAreaElement>('[data-testid="markdown-editor"]')!;
    expect(editor.value).toBe("Current instructions");
    await act(async () => { editor.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); setNativeValue(editor, preserved); });
    await waitFor(() => expect(saveAction).toEqual(expect.any(Function)));
    await act(async () => { saveAction?.(); });
    await waitFor(() => expect(mockAgentsApi.saveInstructionsFile).toHaveBeenCalledWith("agent-1", { path: "CURRENT.md", content: preserved, baseRevisionId: "current-head", clearLegacyPromptTemplate: false }, "company-1"));
    expect(mockAgentsApi.resolveInstructionCandidate).not.toHaveBeenCalled();
  });

  it("retains the draft and its base when a concurrent save conflicts", async () => {
    const summary = makeSummary("AGENTS.md", "AGENTS.md");
    const revision = { id: "base-1", entryFile: "AGENTS.md" } as NonNullable<AgentInstructionsFileDetail["revision"]>;
    await renderPromptsTab(makeBundle("AGENTS.md", [summary]), { "AGENTS.md": makeDetail(summary, "original", { revision }) });
    mockAgentsApi.saveInstructionsFile.mockRejectedValue(new Error("Instructions changed since the base revision"));
    await selectInstructionMode("Edit");
    const editor = container.querySelector<HTMLTextAreaElement>('[data-testid="markdown-editor"]')!;
    await act(async () => { editor.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); setNativeValue(editor, "my unsaved edit"); });
    await waitFor(() => expect(saveAction).toEqual(expect.any(Function)));
    await act(async () => { saveAction?.(); });
    await waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toContain("base revision"));
    expect(editor.value).toBe("my unsaved edit");
    expect(mockAgentsApi.saveInstructionsFile).toHaveBeenCalledWith("agent-1", expect.objectContaining({ content: "my unsaved edit", baseRevisionId: "base-1" }), "company-1");
  });

  it("shows revision content and restores against the displayed current head", async () => {
    const summary = makeSummary("AGENTS.md", "AGENTS.md");
    const revision = { id: "current-1", entryFile: "AGENTS.md" } as NonNullable<AgentInstructionsFileDetail["revision"]>;
    mockAgentsApi.instructionHistory.mockResolvedValue({ revisions: [{ id: "old-revision", source: "board", createdAt: "2026-01-01T00:00:00Z" }], nextCursor: null });
    mockAgentsApi.instructionDiff.mockResolvedValue({ from: { content: "old text" }, removed: "old", added: "new" });
    mockAgentsApi.restoreInstructions.mockResolvedValue(makeDetail(summary, "old text", { revision: { ...revision, id: "restored-1" } }));
    await renderPromptsTab(makeBundle("AGENTS.md", [summary]), { "AGENTS.md": makeDetail(summary, "new text", { revision }) });
    await waitFor(() => expect(buttonByText(container, "History")).toBeDefined());
    await act(async () => { buttonByText(container, "History").click(); });
    await waitFor(() => expect(buttonByText(container, "old-revi")).toBeDefined());
    await act(async () => { buttonByText(container, "old-revi").click(); });
    await waitFor(() => expect(container.textContent).toContain("old text"));
    await act(async () => { buttonByText(container, "Restore as new revision").click(); });
    await waitFor(() => expect(mockAgentsApi.restoreInstructions).toHaveBeenCalledWith("agent-1", { path: "AGENTS.md", revisionId: "old-revision", baseRevisionId: "current-1" }, "company-1"));
  });

  it("ignores rich-editor mount normalization until the user interacts", async () => {
    const summary = makeSummary("AGENTS.md", "AGENTS.md");
    const onDirtyChange = vi.fn();
    await renderPromptsTab(
      makeBundle("AGENTS.md", [summary]),
      { "AGENTS.md": makeDetail(summary, "# Current") },
      { onDirtyChange },
    );
    await selectInstructionMode("Edit");

    const editorProps = await waitFor(() => {
      const latest = markdownEditorRenderMock.mock.calls.at(-1)?.[0] as
        | { onChange?: (value: string) => void }
        | undefined;
      expect(latest?.onChange).toEqual(expect.any(Function));
      return latest!;
    });

    await act(async () => {
      editorProps.onChange?.("# Current\n");
    });
    await flushReact();

    expect(onDirtyChange).not.toHaveBeenCalledWith(true);
    expect(saveAction).toBeNull();
    expect(mockAgentsApi.saveInstructionsFile).not.toHaveBeenCalled();
  });

  it("releases dirty state and save controls when the instructions tab unmounts", async () => {
    const summary = makeSummary("AGENTS.md", "AGENTS.md");
    const onDirtyChange = vi.fn();
    const onSavingChange = vi.fn();
    let cancelAction: (() => void) | null = null;
    await renderPromptsTab(
      makeBundle("AGENTS.md", [summary]),
      { "AGENTS.md": makeDetail(summary, "# Current") },
      {
        onDirtyChange,
        onSavingChange,
        onSaveActionChange: (next) => { saveAction = next; },
        onCancelActionChange: (next) => { cancelAction = next; },
      },
    );
    await selectInstructionMode("Edit");

    const editor = await waitFor(() => {
      const candidate = container.querySelector<HTMLTextAreaElement>('[data-testid="markdown-editor"]');
      expect(candidate).not.toBeNull();
      return candidate!;
    });
    await act(async () => {
      editor.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      setNativeValue(editor, "# Updated");
    });
    await waitFor(() => {
      expect(onDirtyChange).toHaveBeenLastCalledWith(true);
      expect(saveAction).toEqual(expect.any(Function));
      expect(cancelAction).toEqual(expect.any(Function));
    });

    await act(async () => {
      root?.unmount();
    });
    root = null;

    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    expect(onSavingChange).toHaveBeenLastCalledWith(false);
    expect(saveAction).toBeNull();
    expect(cancelAction).toBeNull();
  });

  it("uses the Markdown editor for pending new .md files before server metadata exists", async () => {
    const summary = makeSummary("settings.json", "settings.json", {
      language: "json",
      markdown: false,
    });
    await renderPromptsTab(
      makeBundle("settings.json", [summary]),
      { "settings.json": makeDetail(summary, "{\n  \"ok\": true\n}") },
    );

    await selectInstructionMode("Edit");
    await waitFor(() => {
      expect(container.querySelector<HTMLTextAreaElement>('textarea[placeholder="File contents"]')).not.toBeNull();
    });

    await act(async () => {
      buttonByText(container, "+").click();
    });
    await flushReact();
    const input = container.querySelector<HTMLInputElement>('input[placeholder="TOOLS.md"]');
    expect(input).not.toBeNull();

    await act(async () => {
      setNativeValue(input!, "notes.md");
      buttonByText(container, "Create").click();
    });

    await selectInstructionMode("Edit");
    await waitFor(() => {
      expect(container.querySelector('[data-testid="markdown-editor"]')).not.toBeNull();
    });
    expect(mockAgentsApi.instructionsFile).not.toHaveBeenCalledWith("agent-1", "notes.md", "company-1");
  });

  it("falls back to extension detection for existing .md files when metadata is missing", async () => {
    const summary = makeSummary("FALLBACK.md", "FALLBACK.md", {
      language: "text",
      markdown: undefined,
    });
    await renderPromptsTab(
      makeBundle("FALLBACK.md", [summary]),
      { "FALLBACK.md": makeDetail(summary, "# Fallback", { markdown: undefined }) },
    );

    await selectInstructionMode("Edit");
    await waitFor(() => {
      expect(container.querySelector("[data-testid=\"markdown-editor\"]")).not.toBeNull();
      expect(markdownEditorRenderMock).toHaveBeenLastCalledWith(expect.objectContaining({
        value: "# Fallback",
      }));
    });
  });

  it("keeps the raw textarea when server metadata marks an .md file as non-Markdown", async () => {
    const summary = makeSummary("NOTES.md", "NOTES.md", {
      language: "text",
      markdown: false,
    });
    await renderPromptsTab(
      makeBundle("NOTES.md", [summary]),
      { "NOTES.md": makeDetail(summary, "raw instructions") },
    );

    await selectInstructionMode("Edit");
    await waitFor(() => {
      expect(container.querySelector('[data-testid="markdown-editor"]')).toBeNull();
      expect(container.querySelector<HTMLTextAreaElement>('textarea[placeholder="File contents"]')?.value).toBe("raw instructions");
    });
  });
});

describe("PromptsTab raw instruction editor", () => {
  const sha = (text: string) => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
  // Exact bytes the rich editor would normalize: BOM, leading newline, trailing
  // spaces and tabs, NFD text and a final newline.
  const ORIGINAL = "﻿\n# Sentinel original 9c1d  \n\tindented\tline\ncafé\n";
  const PROPOSED = "﻿\n# Sentinel proposed 4b7e  \n\tindented\tline\ncafé\n\n";
  let container: HTMLDivElement;
  let root: Root | null;
  let queryClient: QueryClient;
  let parentSave: (() => void) | null;
  let consoleSpies: Array<ReturnType<typeof vi.spyOn>>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    parentSave = null;
    markdownEditorRenderMock.mockClear();
    Object.values(mockAgentsApi).forEach((mock) => mock.mockReset());
    mockAgentsApi.instructionCandidates.mockResolvedValue([]);
    consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method));
  });

  afterEach(async () => {
    for (const spy of consoleSpies) {
      const logged = JSON.stringify(spy.mock.calls);
      // W: no instruction content or hashes reach the console.
      expect(logged).not.toContain("Sentinel");
      expect(logged).not.toContain(sha(ORIGINAL));
      expect(logged).not.toContain(sha(PROPOSED));
      spy.mockRestore();
    }
    if (root) await act(async () => { root?.unmount(); });
    queryClient.clear();
    container.remove();
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  function entryDetail(content: string, overrides: Partial<AgentInstructionsFileDetail> = {}) {
    const summary = makeSummary("AGENTS.md", "AGENTS.md", { contentHash: sha(content) });
    return makeDetail(summary, content, { contentHash: sha(content), ...overrides });
  }

  async function renderRaw(detail: AgentInstructionsFileDetail, onDirtyChange = vi.fn()) {
    const summary = makeSummary("AGENTS.md", "AGENTS.md", { contentHash: detail.contentHash });
    mockAgentsApi.instructionsBundle.mockResolvedValue(makeBundle("AGENTS.md", [summary], { persistence: "agent_files" }));
    mockAgentsApi.instructionsFile.mockResolvedValue(detail);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <PromptsTab agent={makeAgent()} companyId="company-1" onDirtyChange={onDirtyChange}
            onSaveActionChange={(next) => { parentSave = next; }} onCancelActionChange={vi.fn()} onSavingChange={vi.fn()} />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await waitFor(() => expect(container.textContent).toContain("Sentinel"));
    await act(async () => { buttonByText(container, "raw").click(); });
    await flushReact();
  }

  const rawEditor = () => container.querySelector<HTMLTextAreaElement>('[data-testid="instructions-raw-editor"]');
  const expectedInput = () => container.querySelector<HTMLInputElement>('input[aria-label="Expected SHA-256"]');
  const saveButton = (label: string) => buttonByText(container, label);

  async function enter(label: "Edit raw" | "Verified installation") {
    await waitFor(() => expect(buttonByText(container, label).disabled).toBe(false));
    await act(async () => { buttonByText(container, label).click(); });
    return waitFor(() => { expect(rawEditor()).not.toBeNull(); return rawEditor()!; });
  }

  async function typeDraft(value: string) {
    await act(async () => { setNativeValue(rawEditor()!, value); });
    await flushReact();
  }

  async function typeExpected(value: string) {
    await act(async () => { setNativeValue(expectedInput()!, value); });
    await flushReact();
  }

  it("A-C, U, X: enters raw edit explicitly from the unmodified server string without MDXEditor", async () => {
    await renderRaw(entryDetail(ORIGINAL));
    // A: Raw view starts read only; editing needs an explicit action.
    expect(rawEditor()).toBeNull();
    expect(container.querySelector('[data-testid="instructions-raw-source"]')?.textContent).toBe(ORIGINAL);
    const editor = await enter("Edit raw");
    // B: exact server string, including BOM, leading newline and trailing whitespace.
    expect(editor.value).toBe(ORIGINAL);
    expect(editor.getAttribute("spellcheck")).toBe("false");
    expect(editor.getAttribute("autocorrect")).toBe("off");
    expect(editor.getAttribute("autocapitalize")).toBe("off");
    // C: MDXEditor is bypassed.
    expect(markdownEditorRenderMock).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="markdown-editor"]')).toBeNull();
    // Ordinary mode shows the pre-save SHA-256 of the exact draft.
    await typeDraft(PROPOSED);
    await waitFor(() => expect(container.querySelector('[data-testid="instructions-raw-draft-hash"]')?.textContent).toBe(sha(PROPOSED)));
    // U: no autosave, and the parent Save stays disconnected from raw drafts.
    for (let i = 0; i < 5; i++) await flushReact();
    expect(mockAgentsApi.saveInstructionsFile).not.toHaveBeenCalled();
    expect(parentSave).toBeNull();
    // X: discarding returns to the unchanged rich editor, which never reuses the raw draft.
    await act(async () => { buttonByText(container, "Discard raw edit").click(); });
    await flushReact();
    await act(async () => { buttonByText(container, "edit").click(); });
    await flushReact();
    const markdown = await waitFor(() => { const el = container.querySelector<HTMLTextAreaElement>('[data-testid="markdown-editor"]'); expect(el).not.toBeNull(); return el!; });
    expect(markdown.value).toBe(ORIGINAL);
  });

  it("D: refuses raw editing when the loaded text does not hash to contentHash", async () => {
    await renderRaw(entryDetail(ORIGINAL, { contentHash: sha("something else") }));
    await waitFor(() => expect(container.querySelector('[data-testid="instructions-raw-ineligible"]')?.textContent).toContain("does not hash"));
    expect(buttonByText(container, "Edit raw").disabled).toBe(true);
    expect(buttonByText(container, "Verified installation").disabled).toBe(true);
    expect(container.querySelector('[data-testid="instructions-raw-source"]')?.textContent).toBe(ORIGINAL);
  });

  it("E: refuses raw editing for CR and CRLF files and shows them unnormalized", async () => {
    const crlf = "# Sentinel crlf\r\nline\rend\n";
    await renderRaw(entryDetail(crlf));
    await waitFor(() => expect(container.querySelector('[data-testid="instructions-raw-ineligible"]')?.textContent).toContain("carriage return"));
    expect(buttonByText(container, "Edit raw").disabled).toBe(true);
    expect(rawEditor()).toBeNull();
    expect(container.querySelector('[data-testid="instructions-raw-source"]')?.textContent).toBe(crlf);
  });

  it("F: refuses raw editing and saving without browser SHA-256", async () => {
    vi.stubGlobal("crypto", undefined);
    await renderRaw(entryDetail(ORIGINAL));
    await waitFor(() => expect(container.querySelector('[data-testid="instructions-raw-ineligible"]')?.textContent).toContain("SHA-256 is unavailable"));
    expect(buttonByText(container, "Edit raw").disabled).toBe(true);
    expect(buttonByText(container, "Verified installation").disabled).toBe(true);
  });

  it("F: disables Save when SHA-256 becomes unavailable during a raw edit", async () => {
    await renderRaw(entryDetail(ORIGINAL));
    await enter("Edit raw");
    vi.stubGlobal("crypto", undefined);
    await typeDraft(PROPOSED);
    await waitFor(() => expect(container.querySelector('[data-testid="instructions-raw-block-reason"]')?.textContent).toContain("could not compute"));
    expect(saveButton("Save raw edit").disabled).toBe(true);
  });

  it("G-J, O: verified installation needs an operator-entered matching hash before Save", async () => {
    await renderRaw(entryDetail(ORIGINAL));
    await enter("Verified installation");
    await typeDraft(PROPOSED);
    // G and H: an expected hash is required and is never prefilled or shown.
    expect(expectedInput()?.value).toBe("");
    await waitFor(() => expect(container.querySelector('[data-testid="instructions-raw-block-reason"]')?.textContent).toContain("Enter the expected SHA-256"));
    expect(container.textContent).not.toContain(sha(PROPOSED));
    expect(saveButton("Save verified installation").disabled).toBe(true);
    // I: a mismatch blocks Save.
    await typeExpected(sha(ORIGINAL));
    await waitFor(() => expect(container.querySelector('[data-testid="instructions-raw-expected-status"]')?.textContent).toBe("Does not match the content to install."));
    expect(saveButton("Save verified installation").disabled).toBe(true);
    await typeExpected("not-a-hash");
    expect(container.querySelector('[data-testid="instructions-raw-expected-status"]')?.textContent).toBe("Not a valid SHA-256.");
    await typeExpected(` ${sha(PROPOSED)}`);
    expect(saveButton("Save verified installation").disabled).toBe(true);
    // J: the correct hash (either case) enables Save once every gate passes.
    await typeExpected(sha(PROPOSED).toUpperCase());
    await waitFor(() => expect(saveButton("Save verified installation").disabled).toBe(false));
    mockAgentsApi.saveInstructionsFile.mockImplementation(async (_id, data) => entryDetail(data.content));
    await act(async () => { saveButton("Save verified installation").click(); });
    await waitFor(() => expect(mockAgentsApi.saveInstructionsFile).toHaveBeenCalledTimes(1));
    // O: exactly path, content and the original baseHash.
    const [agentId, body, companyId] = mockAgentsApi.saveInstructionsFile.mock.calls[0]!;
    expect(agentId).toBe("agent-1");
    expect(companyId).toBe("company-1");
    expect(Object.keys(body).sort()).toEqual(["baseHash", "content", "path"]);
    expect(body).toEqual({ path: "AGENTS.md", content: PROPOSED, baseHash: sha(ORIGINAL) });
    await waitFor(() => expect(container.querySelector('[data-testid="instructions-raw-saved"]')?.textContent).toContain("Verified installation saved"));
    expect(container.querySelector('[data-testid="instructions-raw-saved"]')?.textContent).toContain(sha(PROPOSED));
  });

  it("K: an edit after the hash matched invalidates the expected hash", async () => {
    await renderRaw(entryDetail(ORIGINAL));
    await enter("Verified installation");
    await typeDraft(PROPOSED);
    await typeExpected(sha(PROPOSED));
    await waitFor(() => expect(saveButton("Save verified installation").disabled).toBe(false));
    await typeDraft(`${PROPOSED}x`);
    expect(expectedInput()?.value).toBe("");
    expect(saveButton("Save verified installation").disabled).toBe(true);
    // Restoring the draft does not restore the old binding.
    await typeDraft(PROPOSED);
    for (let i = 0; i < 3; i++) await flushReact();
    expect(expectedInput()?.value).toBe("");
    expect(saveButton("Save verified installation").disabled).toBe(true);
    expect(mockAgentsApi.saveInstructionsFile).not.toHaveBeenCalled();
  });

  it("L, M: modes cannot be switched mid-session and cancel clears verified state", async () => {
    await renderRaw(entryDetail(ORIGINAL));
    await enter("Verified installation");
    await typeDraft(PROPOSED);
    await typeExpected(sha(PROPOSED));
    await waitFor(() => expect(saveButton("Save verified installation").disabled).toBe(false));
    // L: no in-session switch to ordinary mode or to the other views.
    expect(Array.from(container.querySelectorAll("button")).some((b) => b.textContent?.trim() === "Edit raw")).toBe(false);
    expect(buttonByText(container, "edit").disabled).toBe(true);
    expect(buttonByText(container, "read").disabled).toBe(true);
    // M: deliberate cancel clears the draft, the expected hash and the frozen state.
    await act(async () => { buttonByText(container, "Discard raw edit").click(); });
    await flushReact();
    expect(rawEditor()).toBeNull();
    expect(buttonByText(container, "edit").disabled).toBe(false);
    // An ordinary session never inherits verified state.
    await enter("Edit raw");
    expect(rawEditor()?.value).toBe(ORIGINAL);
    expect(expectedInput()).toBeNull();
    expect(container.querySelector('[data-raw-mode]')?.getAttribute("data-raw-mode")).toBe("ordinary");
    await act(async () => { buttonByText(container, "Discard raw edit").click(); });
    await flushReact();
    // Returning to verified mode requires fresh verification.
    await enter("Verified installation");
    expect(expectedInput()?.value).toBe("");
    await typeDraft(PROPOSED);
    expect(saveButton("Save verified installation").disabled).toBe(true);
    expect(mockAgentsApi.saveInstructionsFile).not.toHaveBeenCalled();
  });

  it("N, T: a double click sends one PUT and a confirmed save updates only the edited file", async () => {
    await renderRaw(entryDetail(ORIGINAL));
    await enter("Edit raw");
    await typeDraft(PROPOSED);
    await waitFor(() => expect(saveButton("Save raw edit").disabled).toBe(false));
    let resolveSave: (value: AgentInstructionsFileDetail) => void = () => {};
    mockAgentsApi.saveInstructionsFile.mockImplementation(() => new Promise((resolve) => { resolveSave = resolve; }));
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const button = saveButton("Save raw edit");
    await act(async () => { button.click(); button.click(); });
    button.click();
    await flushReact();
    expect(mockAgentsApi.saveInstructionsFile).toHaveBeenCalledTimes(1);
    expect(saveButton("Saving…").disabled).toBe(true);
    expect(buttonByText(container, "Discard raw edit").disabled).toBe(true);
    await act(async () => { resolveSave(entryDetail(PROPOSED)); });
    await waitFor(() => expect(container.querySelector('[data-testid="instructions-raw-saved"]')?.textContent).toContain(sha(PROPOSED)));
    expect(queryClient.getQueryData<AgentInstructionsFileDetail>(queryKeys.agents.instructionsFile("agent-1", "AGENTS.md"))?.content).toBe(PROPOSED);
    expect(invalidate.mock.calls.map((call) => call[0])).toEqual([{ queryKey: queryKeys.agents.instructionsBundle("agent-1"), exact: true }]);
    expect(mockAgentsApi.saveInstructionsFile).toHaveBeenCalledTimes(1);
  });

  it("P: a 409 keeps the draft and blocks an unsafe retry", async () => {
    await renderRaw(entryDetail(ORIGINAL));
    await enter("Edit raw");
    await typeDraft(PROPOSED);
    await waitFor(() => expect(saveButton("Save raw edit").disabled).toBe(false));
    mockAgentsApi.saveInstructionsFile.mockRejectedValue(new ApiError("Instructions changed since the base revision.", 409, { code: "INSTRUCTION_REVISION_CONFLICT" }));
    await act(async () => { saveButton("Save raw edit").click(); });
    await waitFor(() => expect(container.querySelector('[role="alert"]')?.textContent).toContain("rejected and nothing was written"));
    expect(rawEditor()?.value).toBe(PROPOSED);
    expect(rawEditor()?.readOnly).toBe(true);
    expect(saveButton("Save raw edit").disabled).toBe(true);
    saveButton("Save raw edit").click();
    await flushReact();
    expect(mockAgentsApi.saveInstructionsFile).toHaveBeenCalledTimes(1);
  });

  it("Q, R, V: a lost response enters the unknown state, blocks Save, never retries and reconciles read only", async () => {
    await renderRaw(entryDetail(ORIGINAL));
    await enter("Edit raw");
    await typeDraft(PROPOSED);
    await waitFor(() => expect(saveButton("Save raw edit").disabled).toBe(false));
    mockAgentsApi.saveInstructionsFile.mockRejectedValue(new TypeError("Failed to fetch"));
    await act(async () => { saveButton("Save raw edit").click(); });
    await waitFor(() => expect(container.textContent).toContain("The save outcome is unknown"));
    // R: Save stays disabled and the draft is preserved.
    expect(saveButton("Save raw edit").disabled).toBe(true);
    expect(rawEditor()?.value).toBe(PROPOSED);
    saveButton("Save raw edit").click();
    for (let i = 0; i < 5; i++) await flushReact();
    // V: no retry.
    expect(mockAgentsApi.saveInstructionsFile).toHaveBeenCalledTimes(1);
    // Read-only reconciliation classifies the current file without touching the draft.
    const getsBefore = mockAgentsApi.instructionsFile.mock.calls.length;
    mockAgentsApi.instructionsFile.mockResolvedValue(entryDetail(PROPOSED));
    await act(async () => { buttonByText(container, "Check current saved file").click(); });
    await waitFor(() => expect(container.querySelector('[data-testid="instructions-raw-reconcile"]')?.textContent).toContain("matches the submitted SHA-256"));
    expect(container.querySelector('[data-testid="instructions-raw-reconcile"]')?.textContent).toContain("does not prove");
    expect(mockAgentsApi.instructionsFile.mock.calls.length).toBe(getsBefore + 1);
    expect(rawEditor()?.value).toBe(PROPOSED);
    expect(saveButton("Save raw edit").disabled).toBe(true);
    mockAgentsApi.instructionsFile.mockResolvedValue(entryDetail(ORIGINAL));
    await act(async () => { buttonByText(container, "Check current saved file").click(); });
    await waitFor(() => expect(container.querySelector('[data-testid="instructions-raw-reconcile"]')?.textContent).toContain("still matches the original"));
    expect(mockAgentsApi.saveInstructionsFile).toHaveBeenCalledTimes(1);
  });

  it("S: a response hash mismatch is not reported as success", async () => {
    await renderRaw(entryDetail(ORIGINAL));
    await enter("Edit raw");
    await typeDraft(PROPOSED);
    await waitFor(() => expect(saveButton("Save raw edit").disabled).toBe(false));
    mockAgentsApi.saveInstructionsFile.mockResolvedValue(entryDetail(`${PROPOSED}changed`));
    await act(async () => { saveButton("Save raw edit").click(); });
    await waitFor(() => expect(container.textContent).toContain("did not confirm the submitted SHA-256"));
    expect(container.querySelector('[data-testid="instructions-raw-saved"]')).toBeNull();
    expect(saveButton("Save raw edit").disabled).toBe(true);
    expect(rawEditor()?.value).toBe(PROPOSED);
    expect(queryClient.getQueryData<AgentInstructionsFileDetail>(queryKeys.agents.instructionsFile("agent-1", "AGENTS.md"))?.content).toBe(ORIGINAL);
  });

  it("blocks Save when the server file changes after raw editing starts", async () => {
    await renderRaw(entryDetail(ORIGINAL));
    await enter("Edit raw");
    await typeDraft(PROPOSED);
    await waitFor(() => expect(saveButton("Save raw edit").disabled).toBe(false));
    await act(async () => { queryClient.setQueryData(queryKeys.agents.instructionsFile("agent-1", "AGENTS.md"), entryDetail("# Sentinel newer\n")); });
    await waitFor(() => expect(container.querySelector('[data-testid="instructions-raw-block-reason"]')?.textContent).toContain("changed on the server"));
    expect(saveButton("Save raw edit").disabled).toBe(true);
    expect(rawEditor()?.value).toBe(PROPOSED);
  });

  it("G: refuses raw editing while a rich-editor draft is pending and marks raw sessions dirty", async () => {
    const onDirtyChange = vi.fn();
    await renderRaw(entryDetail(ORIGINAL), onDirtyChange);
    await act(async () => { buttonByText(container, "edit").click(); });
    const markdown = await waitFor(() => { const el = container.querySelector<HTMLTextAreaElement>('[data-testid="markdown-editor"]'); expect(el).not.toBeNull(); return el!; });
    await act(async () => { markdown.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })); setNativeValue(markdown, "# Sentinel rich draft"); });
    await act(async () => { buttonByText(container, "raw").click(); });
    await waitFor(() => expect(container.querySelector('[data-testid="instructions-raw-ineligible"]')?.textContent).toContain("current editor draft"));
    expect(buttonByText(container, "Edit raw").disabled).toBe(true);
    expect(buttonByText(container, "Verified installation").disabled).toBe(true);
  });

  it("locks the Advanced bundle controls while a raw session is open", async () => {
    await renderRaw(entryDetail(ORIGINAL));
    await act(async () => { buttonByText(container, "Advanced").click(); });
    await flushReact();
    const entryInput = () => container.querySelector<HTMLInputElement>('input[value="AGENTS.md"]');
    await waitFor(() => expect(entryInput()).not.toBeNull());
    expect(entryInput()?.disabled).toBe(false);
    await enter("Verified installation");
    await typeDraft(PROPOSED);
    await waitFor(() => expect(entryInput()?.disabled).toBe(true));
    expect(buttonByText(container, "Managed").disabled).toBe(true);
    expect(buttonByText(container, "External").disabled).toBe(true);
    expect(rawEditor()?.value).toBe(PROPOSED);
    await act(async () => { buttonByText(container, "Discard raw edit").click(); });
    await flushReact();
    expect(entryInput()?.disabled).toBe(false);
    expect(buttonByText(container, "Managed").disabled).toBe(false);
  });

  // A non-entry file in a raw session; a later bundle refetch can drop it.
  async function renderNotesRawSession(label: "Edit raw" | "Verified installation") {
    const notesSummary = makeSummary("NOTES.md", "AGENTS.md", { contentHash: sha(ORIGINAL) });
    const notes = makeDetail(notesSummary, ORIGINAL, { contentHash: sha(ORIGINAL) });
    const entry = entryDetail("# Entry file\n");
    const entrySummary = makeSummary("AGENTS.md", "AGENTS.md", { contentHash: entry.contentHash });
    mockAgentsApi.instructionsBundle.mockResolvedValue(makeBundle("AGENTS.md", [entrySummary, notesSummary], { persistence: "agent_files" }));
    mockAgentsApi.instructionsFile.mockImplementation(async (_agentId: string, path: string) => (path === "NOTES.md" ? notes : entry));
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <PromptsTab agent={makeAgent()} companyId="company-1" onDirtyChange={vi.fn()}
            onSaveActionChange={(next) => { parentSave = next; }} onCancelActionChange={vi.fn()} onSavingChange={vi.fn()} />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    const notesNode = await waitFor(() => {
      const node = Array.from(container.querySelectorAll<HTMLElement>("button, [role='treeitem'], span, div"))
        .reverse().find((el) => el.textContent?.trim() === "NOTES.md");
      expect(node).toBeDefined();
      return node!;
    });
    await act(async () => { notesNode.click(); });
    await flushReact();
    await act(async () => { buttonByText(container, "raw").click(); });
    await flushReact();
    await waitFor(() => expect(container.querySelector('[data-testid="instructions-raw-source"]')?.textContent).toBe(ORIGINAL));
    await enter(label);
    await typeDraft(PROPOSED);
    // Another tab deletes NOTES.md; a focus refetch would deliver this bundle.
    return async () => {
      await act(async () => { queryClient.setQueryData(queryKeys.agents.instructionsBundle("agent-1"), makeBundle("AGENTS.md", [entrySummary], { persistence: "agent_files" })); });
      for (let i = 0; i < 3; i++) await flushReact();
    };
  }

  it("keeps a raw session's draft and expected hash when a bundle refetch drops its file", async () => {
    const dropFile = await renderNotesRawSession("Verified installation");
    await typeExpected(sha(PROPOSED));
    await waitFor(() => expect(saveButton("Save verified installation").disabled).toBe(false));
    await dropFile();
    // The session is not silently destroyed; Save is blocked until an explicit discard.
    expect(rawEditor()?.value).toBe(PROPOSED);
    expect(expectedInput()?.value).toBe(sha(PROPOSED));
    expect(saveButton("Save verified installation").disabled).toBe(true);
    expect(buttonByText(container, "Discard raw edit")).toBeDefined();
    expect(mockAgentsApi.saveInstructionsFile).not.toHaveBeenCalled();
  });

  it("keeps the unknown-outcome state and its no-retry guard when a bundle refetch drops the file", async () => {
    const dropFile = await renderNotesRawSession("Edit raw");
    await waitFor(() => expect(saveButton("Save raw edit").disabled).toBe(false));
    mockAgentsApi.saveInstructionsFile.mockRejectedValue(new TypeError("Failed to fetch"));
    await act(async () => { saveButton("Save raw edit").click(); });
    await waitFor(() => expect(container.textContent).toContain("The save outcome is unknown"));
    await dropFile();
    expect(container.textContent).toContain("The save outcome is unknown");
    expect(rawEditor()?.value).toBe(PROPOSED);
    expect(saveButton("Save raw edit").disabled).toBe(true);
    expect(buttonByText(container, "Check current saved file")).toBeDefined();
    saveButton("Save raw edit").click();
    for (let i = 0; i < 5; i++) await flushReact();
    expect(mockAgentsApi.saveInstructionsFile).toHaveBeenCalledTimes(1);
  });

  const binaryRefetch = async () => {
    // Another writer stores a NUL byte; a focus refetch returns binary metadata.
    await act(async () => { queryClient.setQueryData(queryKeys.agents.instructionsFile("agent-1", "AGENTS.md"), entryDetail("# Sentinel binary\u0000\n", { binary: true })); });
    for (let i = 0; i < 3; i++) await flushReact();
  };
  const binaryView = () => container.textContent?.includes("Download it to view its contents") ?? false;

  it("keeps a raw draft and expected hash when a refetch reports the file as binary, with no PUT", async () => {
    await renderRaw(entryDetail(ORIGINAL));
    await enter("Verified installation");
    await typeDraft(PROPOSED);
    await typeExpected(sha(PROPOSED));
    await waitFor(() => expect(saveButton("Save verified installation").disabled).toBe(false));
    const editorBefore = rawEditor();
    await binaryRefetch();
    expect(binaryView()).toBe(false);
    // Same keyed instance, not a remount with a new session.
    expect(rawEditor()).toBe(editorBefore);
    expect(rawEditor()?.value).toBe(PROPOSED);
    expect(expectedInput()?.value).toBe(sha(PROPOSED));
    expect(saveButton("Save verified installation").disabled).toBe(true);
    saveButton("Save verified installation").click();
    for (let i = 0; i < 3; i++) await flushReact();
    expect(mockAgentsApi.saveInstructionsFile).not.toHaveBeenCalled();
  });

  it("keeps the unknown-outcome state and its no-retry guard when a refetch reports the file as binary", async () => {
    await renderRaw(entryDetail(ORIGINAL));
    await enter("Edit raw");
    await typeDraft(PROPOSED);
    await waitFor(() => expect(saveButton("Save raw edit").disabled).toBe(false));
    mockAgentsApi.saveInstructionsFile.mockRejectedValue(new TypeError("Failed to fetch"));
    await act(async () => { saveButton("Save raw edit").click(); });
    await waitFor(() => expect(container.textContent).toContain("The save outcome is unknown"));
    await binaryRefetch();
    expect(binaryView()).toBe(false);
    expect(container.textContent).toContain("The save outcome is unknown");
    expect(rawEditor()?.value).toBe(PROPOSED);
    expect(saveButton("Save raw edit").disabled).toBe(true);
    saveButton("Save raw edit").click();
    for (let i = 0; i < 5; i++) await flushReact();
    expect(mockAgentsApi.saveInstructionsFile).toHaveBeenCalledTimes(1);
  });

  it("keeps an in-flight raw save to one PUT when a refetch reports the file as binary", async () => {
    await renderRaw(entryDetail(ORIGINAL));
    await enter("Edit raw");
    await typeDraft(PROPOSED);
    await waitFor(() => expect(saveButton("Save raw edit").disabled).toBe(false));
    let resolveSave: (value: AgentInstructionsFileDetail) => void = () => {};
    mockAgentsApi.saveInstructionsFile.mockImplementation(() => new Promise<AgentInstructionsFileDetail>((resolve) => { resolveSave = resolve; }));
    await act(async () => { saveButton("Save raw edit").click(); });
    await flushReact();
    expect(mockAgentsApi.saveInstructionsFile).toHaveBeenCalledTimes(1);
    const editorBefore = rawEditor();
    await binaryRefetch();
    expect(binaryView()).toBe(false);
    expect(rawEditor()).toBe(editorBefore);
    expect(saveButton("Saving…").disabled).toBe(true);
    saveButton("Saving…").click();
    for (let i = 0; i < 3; i++) await flushReact();
    expect(mockAgentsApi.saveInstructionsFile).toHaveBeenCalledTimes(1);
    await act(async () => { resolveSave(entryDetail(PROPOSED)); });
    for (let i = 0; i < 3; i++) await flushReact();
    expect(mockAgentsApi.saveInstructionsFile).toHaveBeenCalledTimes(1);
  });

  it("keeps an open raw session mounted when the file query resets and is loading", async () => {
    await renderRaw(entryDetail(ORIGINAL));
    await enter("Edit raw");
    await typeDraft(PROPOSED);
    await waitFor(() => expect(saveButton("Save raw edit").disabled).toBe(false));
    const editorBefore = rawEditor();
    mockAgentsApi.instructionsFile.mockImplementation(() => new Promise(() => {}));
    await act(async () => { void queryClient.resetQueries({ queryKey: queryKeys.agents.instructionsFile("agent-1", "AGENTS.md") }); });
    for (let i = 0; i < 3; i++) await flushReact();
    expect(queryClient.getQueryState(queryKeys.agents.instructionsFile("agent-1", "AGENTS.md"))?.fetchStatus).toBe("fetching");
    expect(queryClient.getQueryData(queryKeys.agents.instructionsFile("agent-1", "AGENTS.md"))).toBeUndefined();
    expect(rawEditor()).toBe(editorBefore);
    expect(rawEditor()?.value).toBe(PROPOSED);
    expect(saveButton("Save raw edit").disabled).toBe(true);
    expect(mockAgentsApi.saveInstructionsFile).not.toHaveBeenCalled();
  });

  it("keeps an open raw session mounted when the bundle query resets and is loading", async () => {
    await renderRaw(entryDetail(ORIGINAL));
    await enter("Edit raw");
    await typeDraft(PROPOSED);
    await waitFor(() => expect(saveButton("Save raw edit").disabled).toBe(false));
    const editorBefore = rawEditor();
    // The sign-out sweep resets account-scoped queries, including this bundle.
    mockAgentsApi.instructionsBundle.mockImplementation(() => new Promise(() => {}));
    await act(async () => { void queryClient.resetQueries({ queryKey: queryKeys.agents.instructionsBundle("agent-1"), exact: true }); });
    for (let i = 0; i < 3; i++) await flushReact();
    expect(queryClient.getQueryData(queryKeys.agents.instructionsBundle("agent-1"))).toBeUndefined();
    expect(rawEditor()).toBe(editorBefore);
    expect(rawEditor()?.value).toBe(PROPOSED);
    expect(saveButton("Save raw edit").disabled).toBe(true);
    expect(mockAgentsApi.saveInstructionsFile).not.toHaveBeenCalled();
  });

  it("restores the normal binary view after an explicit discard", async () => {
    await renderRaw(entryDetail(ORIGINAL));
    await enter("Edit raw");
    await typeDraft(PROPOSED);
    await binaryRefetch();
    expect(binaryView()).toBe(false);
    await act(async () => { buttonByText(container, "Discard raw edit").click(); });
    for (let i = 0; i < 3; i++) await flushReact();
    expect(rawEditor()).toBeNull();
    expect(binaryView()).toBe(true);
    expect(mockAgentsApi.saveInstructionsFile).not.toHaveBeenCalled();
  });

  it("refuses ill-formed and oversized drafts", async () => {
    await renderRaw(entryDetail(ORIGINAL));
    await enter("Edit raw");
    await typeDraft("Sentinel \uD800 lone");
    await waitFor(() => expect(container.querySelector('[data-testid="instructions-raw-block-reason"]')?.textContent).toContain("not well-formed"));
    expect(saveButton("Save raw edit").disabled).toBe(true);
    await typeDraft("a".repeat(1024 * 1024 + 1));
    await waitFor(() => expect(container.querySelector('[data-testid="instructions-raw-block-reason"]')?.textContent).toContain("limit"));
    expect(saveButton("Save raw edit").disabled).toBe(true);
    expect(mockAgentsApi.saveInstructionsFile).not.toHaveBeenCalled();
  });
});
