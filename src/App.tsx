import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";

type NameGroup = {
  id: string;
  title: string;
  names: string[];
  removedIndices: number[];
  createdAt: string;
  updatedAt: string;
};

type AppSettings = {
  selectedGroupId: string | null;
  removePickedNames: boolean;
};

type PersistedState = {
  version: number;
  groups: NameGroup[];
  settings: AppSettings;
};

type WinnerState = {
  id: string;
  groupId: string;
  groupTitle: string;
  name: string;
  pickedAt: string;
};

type StatusState = {
  tone: "neutral" | "success" | "warning";
  text: string;
};

type ToastState = {
  tone: "success" | "warning";
  text: string;
};

type AvailableEntry = {
  index: number;
  name: string;
};

const STORAGE_KEY = "random-name-picker.storage.v1";
const STORAGE_VERSION = 1;
const SLOT_VISIBLE_ROWS = 5;
const SLOT_CENTER_ROW = 2;
const SLOT_ROW_HEIGHT = 74;
const SPIN_DURATION_MS = 5200;

const defaultState = createDefaultState();

function App() {
  const [groups, setGroups] = useState<NameGroup[]>(defaultState.groups);
  const [settings, setSettings] = useState<AppSettings>(defaultState.settings);
  const [storageReady, setStorageReady] = useState(false);
  const [backupDraft, setBackupDraft] = useState(() =>
    serializeGroups(defaultState.groups),
  );
  const [status, setStatus] = useState<StatusState>({
    tone: "neutral",
    text: "Saved locally.",
  });
  const [toast, setToast] = useState<ToastState | null>(null);
  const [reelItems, setReelItems] = useState<string[]>(() =>
    buildIdleStrip(defaultState.groups[0]?.names ?? []),
  );
  const [reelOffset, setReelOffset] = useState(0);
  const [reelDurationMs, setReelDurationMs] = useState(0);
  const [isSpinning, setIsSpinning] = useState(false);
  const [winner, setWinner] = useState<WinnerState | null>(null);
  const [showWinnerOverlay, setShowWinnerOverlay] = useState(false);

  const spinTimerRef = useRef<number | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const selectedGroup = useMemo(
    () => groups.find((group) => group.id === settings.selectedGroupId) ?? null,
    [groups, settings.selectedGroupId],
  );

  const availableEntries = useMemo(
    () => getAvailableEntries(selectedGroup),
    [selectedGroup],
  );
  const removedNameIndices = useMemo(
    () => new Set(selectedGroup?.removedIndices ?? []),
    [selectedGroup?.removedIndices],
  );

  const serializedGroups = useMemo(() => serializeGroups(groups), [groups]);

  useEffect(() => {
    const storedState = readStoredState();

    if (storedState) {
      setGroups(storedState.groups);
      setSettings(normalizeSettings(storedState.settings, storedState.groups));
      setBackupDraft(serializeGroups(storedState.groups));
    }

    setStorageReady(true);
  }, []);

  useEffect(() => {
    if (!storageReady) {
      return;
    }

    const normalizedSettings = normalizeSettings(settings, groups);
    persistState({
      version: STORAGE_VERSION,
      groups,
      settings: normalizedSettings,
    });

    if (
      normalizedSettings.selectedGroupId !== settings.selectedGroupId ||
      normalizedSettings.removePickedNames !== settings.removePickedNames
    ) {
      setSettings(normalizedSettings);
    }
  }, [groups, settings, storageReady]);

  useEffect(() => {
    if (groups.length === 0 && settings.selectedGroupId !== null) {
      setSettings((currentSettings) => ({
        ...currentSettings,
        selectedGroupId: null,
      }));
      return;
    }

    if (
      groups.length > 0 &&
      !groups.some((group) => group.id === settings.selectedGroupId)
    ) {
      setSettings((currentSettings) => ({
        ...currentSettings,
        selectedGroupId: groups[0]?.id ?? null,
      }));
    }
  }, [groups, settings.selectedGroupId]);

  useEffect(() => {
    if (isSpinning) {
      return;
    }

    const idleSource = availableEntries.map((entry) => entry.name);
    const pinnedName =
      winner && winner.groupId === selectedGroup?.id ? winner.name : undefined;

    setReelDurationMs(0);
    setReelOffset(0);
    setReelItems(buildIdleStrip(idleSource, pinnedName));
  }, [availableEntries, isSpinning, selectedGroup?.id, winner]);

  useEffect(() => {
    return () => {
      if (spinTimerRef.current !== null) {
        window.clearTimeout(spinTimerRef.current);
      }

      if (toastTimerRef.current !== null) {
        window.clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  const totalGroups = groups.length;
  const totalNames = groups.reduce(
    (count, group) => count + group.names.length,
    0,
  );
  const availableCount = availableEntries.length;
  const depletedCount = selectedGroup
    ? selectedGroup.names.length - availableEntries.length
    : 0;

  function showToast(toastState: ToastState) {
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
    }

    setToast(toastState);
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null);
      toastTimerRef.current = null;
    }, 2200);
  }

  function handleResetPool() {
    if (!selectedGroup) {
      return;
    }

    setGroups((currentGroups) =>
      currentGroups.map((group) =>
        group.id === selectedGroup.id
          ? {
              ...group,
              removedIndices: [],
              updatedAt: new Date().toISOString(),
            }
          : group,
      ),
    );

    setWinner(null);
    setShowWinnerOverlay(false);
    setStatus({
      tone: "success",
      text: "Pool reset.",
    });
  }

  function handleToggleRemovePickedNames() {
    setSettings((currentSettings) => ({
      ...currentSettings,
      removePickedNames: !currentSettings.removePickedNames,
    }));

    setStatus({
      tone: "neutral",
      text: settings.removePickedNames
        ? "Repeatable mode."
        : "No repeats mode.",
    });
  }

  function handleSpin() {
    if (!selectedGroup || availableEntries.length === 0 || isSpinning) {
      return;
    }

    const winnerAvailableIndex = Math.floor(
      Math.random() * availableEntries.length,
    );
    const winnerEntry = availableEntries[winnerAvailableIndex];

    if (!winnerEntry) {
      return;
    }

    const strip = buildSpinStrip(
      availableEntries.map((entry) => entry.name),
      winnerAvailableIndex,
    );
    const winnerIndex = strip.length - (SLOT_CENTER_ROW + 1);
    const finalOffset = (winnerIndex - SLOT_CENTER_ROW) * SLOT_ROW_HEIGHT;

    setIsSpinning(true);
    setWinner(null);
    setShowWinnerOverlay(false);
    setStatus({
      tone: "neutral",
      text: `Spinning ${selectedGroup.title}...`,
    });
    setReelDurationMs(0);
    setReelOffset(0);
    setReelItems(strip);

    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        setReelDurationMs(SPIN_DURATION_MS);
        setReelOffset(finalOffset);
      });
    });

    if (spinTimerRef.current !== null) {
      window.clearTimeout(spinTimerRef.current);
    }

    spinTimerRef.current = window.setTimeout(() => {
      setIsSpinning(false);
      setWinner({
        id: crypto.randomUUID(),
        groupId: selectedGroup.id,
        groupTitle: selectedGroup.title || "Untitled Group",
        name: winnerEntry.name,
        pickedAt: new Date().toISOString(),
      });
      setShowWinnerOverlay(true);

      if (settings.removePickedNames) {
        setGroups((currentGroups) =>
          currentGroups.map((group) => {
            if (group.id !== selectedGroup.id) {
              return group;
            }

            return {
              ...group,
              removedIndices: [
                ...new Set([...group.removedIndices, winnerEntry.index]),
              ],
              updatedAt: new Date().toISOString(),
            };
          }),
        );
      }

      setStatus({
        tone: "success",
        text: `${winnerEntry.name} selected.`,
      });
      spinTimerRef.current = null;
    }, SPIN_DURATION_MS + 80);
  }

  function applyPlaintext(text: string, loadedFromFile = false) {
    try {
      const parsedGroups = parsePlaintext(text);
      const nextGroups = reconcileGroups(groups, parsedGroups);

      setGroups(nextGroups);
      setSettings((currentSettings) =>
        normalizeSettings(currentSettings, nextGroups),
      );
      setWinner(null);
      setShowWinnerOverlay(false);
      setStatus({
        tone: "success",
        text:
          nextGroups.length === 0
            ? "Lists cleared."
            : loadedFromFile
              ? `Loaded ${nextGroups.length} list${nextGroups.length === 1 ? "" : "s"}.`
              : "Lists updated.",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Import failed.";
      setStatus({ tone: "warning", text: message });
    }
  }

  function handleResetDraft() {
    setBackupDraft(serializedGroups);
    setStatus({ tone: "neutral", text: "Draft reset." });
  }

  function handleDownloadPlaintext() {
    const filename = `random-name-picker-backup-${new Date().toISOString().slice(0, 10)}.txt`;
    downloadTextFile(serializedGroups, filename);
    setStatus({ tone: "success", text: "Backup downloaded." });
  }

  async function handleCopyPlaintext() {
    try {
      await navigator.clipboard.writeText(serializedGroups);
      setStatus({ tone: "success", text: "Backup copied." });
      showToast({ tone: "success", text: "Copied lists to clipboard." });
    } catch {
      setStatus({
        tone: "warning",
        text: "Copy failed.",
      });
      showToast({ tone: "warning", text: "Copy failed." });
    }
  }

  async function handleFileImport(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    const fileText = await file.text();
    setBackupDraft(fileText);
    applyPlaintext(fileText, true);
    event.target.value = "";
  }

  return (
    <div className="app-shell">
      <div className="page-noise" aria-hidden="true" />
      <div className="page-dots" aria-hidden="true" />
      {winner && showWinnerOverlay ? (
        <div
          className="winner-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Chosen name"
          onClick={() => setShowWinnerOverlay(false)}
        >
          <div className="winner-overlay-backdrop" aria-hidden="true" />
          <div className="winner-overlay-card" onClick={(event) => event.stopPropagation()}>
            <p className="winner-overlay-label">Chosen Name</p>
            <h2
              className="winner-overlay-name"
              style={{ fontSize: getWinnerOverlayFontSize(winner.name) }}
            >
              {winner.name}
            </h2>
            <p className="winner-overlay-group">{winner.groupTitle}</p>
            <div className="winner-overlay-shine" aria-hidden="true" />
            <button
              className="winner-overlay-close"
              type="button"
              onClick={() => setShowWinnerOverlay(false)}
            >
              Continue
            </button>
          </div>
        </div>
      ) : null}
      {toast ? (
        <div className={`toast toast-${toast.tone}`} role="status" aria-live="polite">
          {toast.text}
        </div>
      ) : null}

      <main className="layout">
        <section className="topbar panel">
          <div className="topbar-main">
            <div className="hero-copy">
              <h1>Tea Time!</h1>
            </div>

            <div className="topbar-tools">
              <button
                className={`mode-toggle mode-toggle-compact ${settings.removePickedNames ? "mode-toggle-on" : ""}`}
                type="button"
                onClick={handleToggleRemovePickedNames}
              >
                <span className="mode-toggle-thumb" aria-hidden="true" />
                <span>
                  {settings.removePickedNames ? "No repeats" : "Repeatable"}
                </span>
              </button>
            </div>
          </div>
        </section>

        <section className="workspace">
          <aside className="panel sidebar-panel">
            <div className="panel-heading compact-heading">
              <h2>Lists</h2>
            </div>

            <div className="group-stack">
              {groups.length === 0 ? (
                <div className="empty-card">
                  <p>No lists yet.</p>
                </div>
              ) : (
                groups.map((group) => {
                  const available = getAvailableEntries(group).length;

                  return (
                    <button
                      key={group.id}
                      className={`group-card ${group.id === selectedGroup?.id ? "group-card-active" : ""}`}
                      type="button"
                      onClick={() => {
                        if (isSpinning) {
                          return;
                        }

                        setSettings((currentSettings) => ({
                          ...currentSettings,
                          selectedGroupId: group.id,
                        }));
                      }}
                      disabled={isSpinning}
                    >
                      <span className="group-title">
                        {group.title || "Untitled Group"}
                      </span>
                      <span className="group-meta">
                        {available}/{group.names.length}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </aside>

          <section className="panel stage-panel">
            <div className="panel-heading stage-header">
              <div>
                <h2>{selectedGroup?.title || "Choose a list"}</h2>
                <p className="stage-summary">
                  {selectedGroup
                    ? `${availableCount}/${selectedGroup.names.length} ready${
                        settings.removePickedNames && depletedCount > 0
                          ? ` · ${depletedCount} out`
                          : ""
                      }`
                    : "Select a list to start."}
                </p>
              </div>

              <div className="stage-actions">
                <button
                  className="secondary-button"
                  type="button"
                  onClick={handleResetPool}
                  disabled={
                    !selectedGroup ||
                    selectedGroup.removedIndices.length === 0 ||
                    isSpinning
                  }
                >
                  Reset
                </button>
                <button
                  className="primary-button spin-button"
                  type="button"
                  onClick={handleSpin}
                  disabled={
                    !selectedGroup ||
                    availableEntries.length === 0 ||
                    isSpinning
                  }
                >
                  {isSpinning ? "Spinning..." : "Spin"}
                </button>
              </div>
            </div>

            <div
              className={`slot-machine slot-machine-minimal ${isSpinning ? "slot-machine-active" : ""}`}
            >
              <div className="slot-viewport">
                <div className="slot-focus-band" aria-hidden="true" />
                <div
                  className="slot-reel"
                  style={{
                    transform: `translateY(-${reelOffset}px)`,
                    transitionDuration: `${reelDurationMs}ms`,
                  }}
                >
                  {reelItems.map((item, index) => (
                    <div className="slot-row" key={`${item}-${index}`}>
                      <span>{item}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {selectedGroup ? (
              <div className="names-grid-section">
                <div className="names-grid-header">
                  <h3>Names</h3>
                  <span>{selectedGroup.names.length}</span>
                </div>

                <div className="names-grid">
                  {selectedGroup.names.map((name, index) => {
                    const isWinner = winner?.groupId === selectedGroup.id && winner.name === name;
                    const isRemoved = removedNameIndices.has(index);

                    return (
                      <div
                        key={`${name}-${index}`}
                        className={`name-chip ${isWinner ? "name-chip-winner" : ""} ${isRemoved ? "name-chip-removed" : ""}`}
                      >
                        <span>{name}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </section>

          <aside className="panel backup-panel">
            <div className="panel-heading compact-heading">
              <h2>Lists</h2>
              <button
                className="secondary-button"
                type="button"
                onClick={handleResetDraft}
              >
                Reset
              </button>
            </div>

            <textarea
              className="backup-area"
              value={backupDraft}
              onChange={(event) => {
                const nextText = event.target.value;
                setBackupDraft(nextText);
                applyPlaintext(nextText);
              }}
              placeholder={"[Group Name]\nAlice\nBob\nCharlie"}
              rows={20}
              spellCheck={false}
            />

            <div className="backup-actions">
              <button
                className="secondary-button"
                type="button"
                onClick={handleDownloadPlaintext}
              >
                Download
              </button>
              <button
                className="secondary-button"
                type="button"
                onClick={handleCopyPlaintext}
              >
                Copy
              </button>
              <button
                className="secondary-button"
                type="button"
                onClick={() => fileInputRef.current?.click()}
              >
                Load file
              </button>
              <input
                ref={fileInputRef}
                className="sr-only"
                type="file"
                accept=".txt,text/plain"
                onChange={handleFileImport}
              />
            </div>
          </aside>
        </section>
      </main>
    </div>
  );
}

function createDefaultState(): PersistedState {
  const groups = [
    createGroup("Workshop Volunteers", [
      "Ava Patel",
      "Jayden Nguyen",
      "Mia Thompson",
      "Noah Kim",
      "Sofia Chen",
      "Lucas Martin",
    ]),
    createGroup("Design Review", [
      "Priya Shah",
      "Leo Ramirez",
      "Harper Singh",
      "Owen Wilson",
      "Ella Brooks",
    ]),
    createGroup("Prize Draw", [
      "Aria Cooper",
      "Ethan Scott",
      "Grace Hall",
      "Mason Green",
      "Zoe Parker",
      "Liam Morris",
    ]),
  ];

  return {
    version: STORAGE_VERSION,
    groups,
    settings: {
      selectedGroupId: groups[0]?.id ?? null,
      removePickedNames: false,
    },
  };
}

function createGroup(title: string, names: string[]): NameGroup {
  const timestamp = new Date().toISOString();

  return {
    id: crypto.randomUUID(),
    title,
    names,
    removedIndices: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function normalizeSettings(
  settings: AppSettings,
  groups: NameGroup[],
): AppSettings {
  return {
    removePickedNames: Boolean(settings.removePickedNames),
    selectedGroupId: groups.some(
      (group) => group.id === settings.selectedGroupId,
    )
      ? settings.selectedGroupId
      : (groups[0]?.id ?? null),
  };
}

function readStoredState(): PersistedState | null {
  try {
    const storedValue = window.localStorage.getItem(STORAGE_KEY);

    if (!storedValue) {
      return null;
    }

    const parsedValue = JSON.parse(storedValue) as PersistedState;

    if (
      parsedValue.version !== STORAGE_VERSION ||
      !Array.isArray(parsedValue.groups)
    ) {
      return null;
    }

    const groups = parsedValue.groups
      .map((group) => sanitizeGroup(group))
      .filter((group): group is NameGroup => group !== null);

    return {
      version: STORAGE_VERSION,
      groups,
      settings: normalizeSettings(parsedValue.settings, groups),
    };
  } catch {
    return null;
  }
}

function sanitizeGroup(group: unknown): NameGroup | null {
  if (!group || typeof group !== "object") {
    return null;
  }

  const candidate = group as Partial<NameGroup>;

  if (!Array.isArray(candidate.names)) {
    return null;
  }

  return {
    id:
      typeof candidate.id === "string" && candidate.id
        ? candidate.id
        : crypto.randomUUID(),
    title:
      typeof candidate.title === "string" ? candidate.title : "Untitled Group",
    names: candidate.names.filter(
      (name): name is string => typeof name === "string",
    ),
    removedIndices: Array.isArray(candidate.removedIndices)
      ? candidate.removedIndices.filter(
          (value): value is number => typeof value === "number" && value >= 0,
        )
      : [],
    createdAt:
      typeof candidate.createdAt === "string"
        ? candidate.createdAt
        : new Date().toISOString(),
    updatedAt:
      typeof candidate.updatedAt === "string"
        ? candidate.updatedAt
        : new Date().toISOString(),
  };
}

function persistState(state: PersistedState) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage can fail in private browsing or quota limits. The app should stay usable.
  }
}

function getAvailableEntries(group: NameGroup | null): AvailableEntry[] {
  if (!group) {
    return [];
  }

  const removedIndices = new Set(group.removedIndices);

  return group.names
    .map((name, index) => ({ index, name }))
    .filter((entry) => !removedIndices.has(entry.index));
}

function parseNames(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function serializeGroups(groups: NameGroup[]): string {
  return groups
    .map((group) => {
      const title = group.title.trim() || "Untitled Group";
      const body = group.names.join("\n");
      return `[${title}]${body ? `\n${body}` : ""}`;
    })
    .join("\n\n");
}

function parsePlaintext(text: string): NameGroup[] {
  const trimmedText = text.trim();

  if (!trimmedText) {
    return [];
  }

  const lines = trimmedText.split(/\r?\n/);
  const draftGroups: Array<{ title: string; names: string[] }> = [];
  const usedTitles = new Set<string>();
  let currentTitle = "";
  let currentNames: string[] = [];
  let implicitIndex = 1;

  function pushCurrentGroup() {
    if (!currentTitle && currentNames.length === 0) {
      return;
    }

    const baseTitle = currentTitle || `Imported Group ${implicitIndex++}`;
    const title = ensureUniqueTitle(baseTitle, usedTitles);
    draftGroups.push({ title, names: [...currentNames] });
    currentTitle = "";
    currentNames = [];
  }

  for (const line of lines) {
    const trimmedLine = line.trim();

    if (!trimmedLine) {
      continue;
    }

    const match = trimmedLine.match(/^\[(.+)]$/);

    if (match) {
      pushCurrentGroup();
      currentTitle =
        (match[1] ?? "").trim() || `Imported Group ${implicitIndex++}`;
      continue;
    }

    currentNames.push(trimmedLine);
  }

  pushCurrentGroup();

  if (draftGroups.length === 0) {
    throw new Error(
      "The plaintext backup needs at least one [Group Name] block or one name line.",
    );
  }

  return draftGroups.map((group) => createGroup(group.title, group.names));
}

function reconcileGroups(
  existingGroups: NameGroup[],
  parsedGroups: NameGroup[],
): NameGroup[] {
  const unusedGroups = [...existingGroups];

  return parsedGroups.map((parsedGroup) => {
    const matchIndex = unusedGroups.findIndex(
      (group) => group.title.trim() === parsedGroup.title.trim(),
    );

    if (matchIndex === -1) {
      return parsedGroup;
    }

    const [matchedGroup] = unusedGroups.splice(matchIndex, 1);

    if (!matchedGroup) {
      return parsedGroup;
    }

    const namesChanged =
      matchedGroup.names.length !== parsedGroup.names.length ||
      matchedGroup.names.some((name, index) => name !== parsedGroup.names[index]);

    return {
      ...parsedGroup,
      id: matchedGroup.id,
      createdAt: matchedGroup.createdAt,
      removedIndices: namesChanged ? [] : matchedGroup.removedIndices,
      updatedAt: new Date().toISOString(),
    };
  });
}

function buildIdleStrip(names: string[], pinnedName?: string): string[] {
  const source = names.length > 0 ? names : idleFallbackNames;
  const centerIndex = pinnedName
    ? Math.max(source.indexOf(pinnedName), 0)
    : Math.floor(Math.random() * source.length);

  return buildVisibleWindow(source, centerIndex);
}

function buildSpinStrip(names: string[], winnerIndex: number): string[] {
  const source = names.length > 0 ? names : idleFallbackNames;
  const normalizedWinnerIndex = normalizeIndex(winnerIndex, source.length);
  const randomStartIndex = Math.floor(Math.random() * source.length);
  const cycles = Math.max(6, Math.ceil(36 / source.length));
  const strip = buildRepeatedSequence(source, cycles, randomStartIndex);

  return [...strip, ...buildVisibleWindow(source, normalizedWinnerIndex)];
}

function buildVisibleWindow(source: string[], centerIndex: number): string[] {
  return Array.from({ length: SLOT_VISIBLE_ROWS }, (_, slotIndex) => {
    const offset = slotIndex - SLOT_CENTER_ROW;
    return source[normalizeIndex(centerIndex + offset, source.length)] ?? "Ready";
  });
}

function buildRepeatedSequence(
  source: string[],
  cycles: number,
  startIndex: number,
): string[] {
  const sequence: string[] = [];

  for (let cycle = 0; cycle < cycles; cycle += 1) {
    for (let index = 0; index < source.length; index += 1) {
      sequence.push(source[normalizeIndex(startIndex + index, source.length)] ?? "Ready");
    }
  }

  return sequence;
}

function normalizeIndex(index: number, length: number): number {
  return ((index % length) + length) % length;
}

function getWinnerOverlayFontSize(name: string): string {
  const longestWordLength = name
    .split(/\s+/)
    .reduce((maxLength, word) => Math.max(maxLength, word.length), 0);

  const score = Math.max(name.length, longestWordLength * 1.5);

  if (score > 34) {
    return "2.8rem";
  }

  if (score > 28) {
    return "3.4rem";
  }

  if (score > 22) {
    return "4.2rem";
  }

  if (score > 16) {
    return "5.2rem";
  }

  return "clamp(3.4rem, 10vw, 7rem)";
}

function ensureUniqueTitle(baseTitle: string, usedTitles: Set<string>): string {
  const cleanedTitle = baseTitle.trim() || "Untitled Group";
  let suffix = 2;
  let candidate = cleanedTitle;

  while (usedTitles.has(candidate.toLowerCase())) {
    candidate = `${cleanedTitle} (${suffix})`;
    suffix += 1;
  }

  usedTitles.add(candidate.toLowerCase());
  return candidate;
}

function downloadTextFile(text: string, filename: string) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = url;
  link.download = filename;
  link.click();

  URL.revokeObjectURL(url);
}

const idleFallbackNames = [
  "Add names",
  "Save groups",
  "Spin slow",
  "Pick a winner",
  "Restore from text",
];

export default App;
