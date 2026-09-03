import {
  DEFAULT_CHAT_HIGHLIGHTS,
  DEFAULT_NAME_DISPLAY_MODE,
  dedupeGiftCatalogByName,
  type ChatHighlightConfig,
  type GiftAlertRule,
  type GiftCatalogItem,
  type GlobalSettings,
  type NameDisplayMode,
  type StreamConfig,
} from '@tiktok-mod/shared';
import { useEffect, useRef, useState } from 'react';
import {
  getConfig,
  getGiftCatalog,
  getGlobalSettings,
  putConfig,
  putGlobalSettings,
} from './api';

const AUTOSAVE_MS = 450;

export type StreamRow = {
  streamId: string;
  addedAt: number;
  isCheckedIn: boolean;
  watcherCount: number;
  youAreWatching: boolean;
};

function checkInLabel(stream: StreamRow): string {
  if (!stream.isCheckedIn) return 'out';
  if (stream.watcherCount > 1) return `checked in · ${stream.watcherCount}`;
  return 'checked in';
}

function isUnauthorized(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('401:');
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'Something went wrong';
}

function SwitchField(
  props: Readonly<{
    label: string;
    checked: boolean;
    onChange: (checked: boolean) => void;
    hint?: string | null;
  }>,
) {
  return (
    <label className="switch-field">
      <span>
        {props.label}
        {props.hint ? <span className="muted"> · {props.hint}</span> : null}
      </span>
      <span className="switch">
        <input
          type="checkbox"
          role="switch"
          checked={props.checked}
          onChange={(e) => props.onChange(e.target.checked)}
        />
        <span className="switch-ui" aria-hidden />
      </span>
    </label>
  );
}

function splitSettingLines(text: string): string[] {
  return text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isDiamondRule(rule: GiftAlertRule): boolean {
  return typeof rule.minDiamondValue === 'number' && !rule.giftName;
}

function namedGiftRules(rules: GiftAlertRule[]): GiftAlertRule[] {
  return rules.filter((r) => Boolean(r.giftName?.trim()));
}

async function loadCatalogWithExtras(
  namedRules: GiftAlertRule[],
): Promise<GiftCatalogItem[]> {
  let fromCatalog: GiftCatalogItem[] = [];
  try {
    fromCatalog = (await getGiftCatalog()).gifts ?? [];
  } catch {
    // keep empty catalog
  }
  const catalogKeys = new Set(fromCatalog.map((g) => g.name.toLowerCase()));
  const extras: GiftCatalogItem[] = namedRules
    .map((r) => r.giftName?.trim())
    .filter((n): n is string => Boolean(n))
    .filter((n) => !catalogKeys.has(n.toLowerCase()))
    .map((name) => ({ id: null, name, diamondValue: null }));
  return dedupeGiftCatalogByName([...extras, ...fromCatalog]);
}

function listPlaceholder(
  mode: 'global' | 'stream',
  globalLines: string[] | undefined,
  emptyGlobalHint: string,
  globalHint: string,
): string {
  if (mode !== 'stream') return emptyGlobalHint;
  if (globalLines && globalLines.length > 0) {
    return `Global:\n${globalLines.join('\n')}`;
  }
  return globalHint;
}

function numberPlaceholder(
  mode: 'global' | 'stream',
  globalValue: number | undefined,
  fallback: number,
): string | undefined {
  if (mode !== 'stream') return undefined;
  return `Global: ${globalValue ?? fallback}`;
}

function autosaveLabel(
  status: 'idle' | 'saving' | 'saved' | 'error',
): string | null {
  if (status === 'saving') return 'Saving…';
  if (status === 'saved') return 'Saved';
  if (status === 'error') return 'Save failed';
  return null;
}

type EditorState = {
  keywordsText: string;
  minDiamonds: string;
  /** null = inherit global (stream mode only) */
  notifyDiamonds: boolean | null;
  catalogGifts: GiftCatalogItem[];
  enabledGiftKeys: Set<string>;
  notifyGifts: boolean | null;
  highlightUsersText: string;
  highlightRecentGifters: boolean | null;
  recentGifterMinDiamonds: string;
  recentGifterWindowSeconds: string;
  nameDisplayMode: NameDisplayMode;
};

function emptyEditorState(catalog: GiftCatalogItem[] = []): EditorState {
  return {
    keywordsText: '',
    minDiamonds: '',
    notifyDiamonds: null,
    catalogGifts: catalog,
    enabledGiftKeys: new Set(),
    notifyGifts: null,
    highlightUsersText: '',
    highlightRecentGifters: null,
    recentGifterMinDiamonds: '',
    recentGifterWindowSeconds: '',
    nameDisplayMode: DEFAULT_NAME_DISPLAY_MODE,
  };
}

function stateFromAlertSettings(
  settings: {
    giftAlertRules: GiftAlertRule[];
    chatKeywordFlags: string[];
    chatHighlights: ChatHighlightConfig;
  },
  catalogGifts: GiftCatalogItem[],
  nameDisplayMode: NameDisplayMode = DEFAULT_NAME_DISPLAY_MODE,
): EditorState {
  const diamondRule = settings.giftAlertRules.find(isDiamondRule);
  const named = namedGiftRules(settings.giftAlertRules);
  const h = settings.chatHighlights ?? DEFAULT_CHAT_HIGHLIGHTS;
  return {
    keywordsText: settings.chatKeywordFlags.join('\n'),
    minDiamonds: String(diamondRule?.minDiamondValue ?? 100),
    notifyDiamonds: diamondRule?.notify !== false,
    catalogGifts,
    enabledGiftKeys: new Set(
      named
        .map((r) => r.giftName?.trim().toLowerCase())
        .filter((n): n is string => Boolean(n)),
    ),
    notifyGifts: named.length === 0 || named.some((r) => r.notify !== false),
    highlightUsersText: h.highlightUsernames.join('\n'),
    highlightRecentGifters: h.highlightRecentGifters,
    recentGifterMinDiamonds: String(h.recentGifterMinDiamonds),
    recentGifterWindowSeconds: String(h.recentGifterWindowSeconds),
    nameDisplayMode,
  };
}

function applyGiftRuleOverrides(
  base: EditorState,
  giftRules: GiftAlertRule[] | null | undefined,
): void {
  if (giftRules == null || giftRules.length === 0) return;
  const diamond = giftRules.find(isDiamondRule);
  const named = namedGiftRules(giftRules);
  if (diamond) {
    base.minDiamonds = String(diamond.minDiamondValue ?? '');
    base.notifyDiamonds = diamond.notify !== false;
  }
  if (named.length === 0) return;
  base.enabledGiftKeys = new Set(
    named
      .map((r) => r.giftName?.trim().toLowerCase())
      .filter((n): n is string => Boolean(n)),
  );
  base.notifyGifts = named.some((r) => r.notify !== false);
}

function applyChatHighlightOverrides(
  base: EditorState,
  h: Partial<ChatHighlightConfig> | null | undefined,
): void {
  if (!h) return;
  if (h.highlightUsernames != null && h.highlightUsernames.length > 0) {
    base.highlightUsersText = h.highlightUsernames.join('\n');
  }
  if (typeof h.highlightRecentGifters === 'boolean') {
    base.highlightRecentGifters = h.highlightRecentGifters;
  }
  if (typeof h.recentGifterMinDiamonds === 'number') {
    base.recentGifterMinDiamonds = String(h.recentGifterMinDiamonds);
  }
  if (typeof h.recentGifterWindowSeconds === 'number') {
    base.recentGifterWindowSeconds = String(h.recentGifterWindowSeconds);
  }
}

function stateFromOverrides(
  cfg: StreamConfig,
  catalogGifts: GiftCatalogItem[],
): EditorState {
  const global = cfg.global ?? {
    giftAlertRules: [],
    chatKeywordFlags: [],
    chatHighlights: DEFAULT_CHAT_HIGHLIGHTS,
    nameDisplayMode: DEFAULT_NAME_DISPLAY_MODE,
  };
  const o = cfg.overrides ?? {};
  const base = emptyEditorState(catalogGifts);
  base.nameDisplayMode = global.nameDisplayMode;

  applyGiftRuleOverrides(base, o.giftAlertRules);
  if (o.chatKeywordFlags != null && o.chatKeywordFlags.length > 0) {
    base.keywordsText = o.chatKeywordFlags.join('\n');
  }
  applyChatHighlightOverrides(base, o.chatHighlights);

  return base;
}

function buildGlobalPayload(state: EditorState): GlobalSettings {
  const names = state.catalogGifts
    .filter((g) => state.enabledGiftKeys.has(g.name.toLowerCase()))
    .map((g) => g.name);
  const diamondValue = Number(state.minDiamonds) || 100;
  return {
    giftAlertRules: [
      {
        minDiamondValue: diamondValue,
        label: `Gift ≥ ${diamondValue} diamonds`,
        notify: state.notifyDiamonds !== false,
      },
      ...names.map((giftName) => ({
        giftName,
        label: giftName,
        notify: state.notifyGifts !== false,
      })),
    ],
    chatKeywordFlags: splitSettingLines(state.keywordsText),
    chatHighlights: {
      highlightUsernames: splitSettingLines(state.highlightUsersText).map((s) =>
        s.replace(/^@/, ''),
      ),
      highlightRecentGifters: state.highlightRecentGifters !== false,
      recentGifterMinDiamonds: Number(state.recentGifterMinDiamonds) || 1,
      recentGifterWindowSeconds: Number(state.recentGifterWindowSeconds) || 120,
    },
    nameDisplayMode: state.nameDisplayMode,
  };
}

function buildOverrideGiftAlertRules(
  state: EditorState,
  global: GlobalSettings | null,
): GiftAlertRule[] | null | undefined {
  const diamondTouched =
    state.notifyDiamonds != null || state.minDiamonds.trim() !== '';
  const giftsTouched =
    state.notifyGifts != null || state.enabledGiftKeys.size > 0;
  if (!diamondTouched && !giftsTouched) return undefined;

  const giftAlertRules: GiftAlertRule[] = [];
  if (diamondTouched) {
    const diamondValue =
      Number(state.minDiamonds) ||
      global?.giftAlertRules.find(isDiamondRule)?.minDiamondValue ||
      100;
    giftAlertRules.push({
      minDiamondValue: diamondValue,
      label: `Gift ≥ ${diamondValue} diamonds`,
      notify: state.notifyDiamonds !== false,
    });
  }
  if (giftsTouched) {
    let names = state.catalogGifts
      .filter((g) => state.enabledGiftKeys.has(g.name.toLowerCase()))
      .map((g) => g.name);
    // Switch toggled with no local gift list → override notify on global names.
    if (names.length === 0 && state.notifyGifts != null && global) {
      names = namedGiftRules(global.giftAlertRules)
        .map((r) => r.giftName?.trim())
        .filter((n): n is string => Boolean(n));
    }
    for (const giftName of names) {
      giftAlertRules.push({
        giftName,
        label: giftName,
        notify: state.notifyGifts !== false,
      });
    }
  }
  return giftAlertRules.length > 0 ? giftAlertRules : null;
}

function buildOverrideChatHighlights(
  state: EditorState,
): Partial<ChatHighlightConfig> | null {
  const highlightUsers = splitSettingLines(state.highlightUsersText).map((s) =>
    s.replace(/^@/, ''),
  );
  const chatHighlights: Partial<ChatHighlightConfig> = {};
  if (highlightUsers.length > 0) {
    chatHighlights.highlightUsernames = highlightUsers;
  }
  if (state.highlightRecentGifters != null) {
    chatHighlights.highlightRecentGifters = state.highlightRecentGifters;
  }
  if (state.recentGifterMinDiamonds.trim() !== '') {
    chatHighlights.recentGifterMinDiamonds =
      Number(state.recentGifterMinDiamonds) || 1;
  }
  if (state.recentGifterWindowSeconds.trim() !== '') {
    chatHighlights.recentGifterWindowSeconds =
      Number(state.recentGifterWindowSeconds) || 120;
  }
  return Object.keys(chatHighlights).length > 0 ? chatHighlights : null;
}

function buildStreamOverridePayload(
  state: EditorState,
  global: GlobalSettings | null,
): {
  giftAlertRules?: GiftAlertRule[] | null;
  chatKeywordFlags?: string[] | null;
  chatHighlights?: Partial<ChatHighlightConfig> | null;
} {
  const keywords = splitSettingLines(state.keywordsText);
  return {
    giftAlertRules: buildOverrideGiftAlertRules(state, global),
    // Always send keywords: empty clears override (inherit).
    chatKeywordFlags: keywords.length > 0 ? keywords : null,
    chatHighlights: buildOverrideChatHighlights(state),
  };
}

function GiftPickerItem(
  props: Readonly<{
    gift: GiftCatalogItem;
    checked: boolean;
    onToggle: (key: string) => void;
  }>,
) {
  const key = props.gift.name.toLowerCase();
  return (
    <label className="check-field gift-picker-item">
      <input
        type="checkbox"
        checked={props.checked}
        onChange={() => props.onToggle(key)}
      />
      <span>{props.gift.name}</span>
      {props.gift.diamondValue != null ? (
        <span className="muted">{props.gift.diamondValue}◆</span>
      ) : null}
    </label>
  );
}

function GiftPicker(
  props: Readonly<{
    catalogGifts: GiftCatalogItem[];
    catalogQuery: string;
    enabledGiftKeys: Set<string>;
    onQueryChange: (value: string) => void;
    onToggleKey: (key: string) => void;
  }>,
) {
  const query = props.catalogQuery.trim().toLowerCase();
  const selectedGifts = props.catalogGifts.filter((g) =>
    props.enabledGiftKeys.has(g.name.toLowerCase()),
  );
  const searchHits =
    query.length === 0
      ? []
      : props.catalogGifts
          .filter((g) => g.name.toLowerCase().includes(query))
          .filter((g) => !props.enabledGiftKeys.has(g.name.toLowerCase()))
          .slice(0, 40);

  if (props.catalogGifts.length === 0) {
    return <p className="muted">Gift catalog unavailable.</p>;
  }

  return (
    <>
      <input
        type="search"
        value={props.catalogQuery}
        onChange={(e) => props.onQueryChange(e.target.value)}
        placeholder="Search live gifts to add"
      />
      {selectedGifts.length > 0 ? (
        <div className="gift-picker">
          {selectedGifts.map((gift) => (
            <GiftPickerItem
              key={gift.name.toLowerCase()}
              gift={gift}
              checked
              onToggle={props.onToggleKey}
            />
          ))}
        </div>
      ) : (
        <p className="muted">No important gifts selected yet.</p>
      )}
      {query.length > 0 ? (
        <div className="gift-picker gift-picker-search">
          {searchHits.length === 0 ? (
            <p className="muted">No matching gifts.</p>
          ) : (
            searchHits.map((gift) => (
              <GiftPickerItem
                key={gift.name.toLowerCase()}
                gift={gift}
                checked={false}
                onToggle={props.onToggleKey}
              />
            ))
          )}
        </div>
      ) : (
        <p className="muted">
          Search to add from {props.catalogGifts.length} live gifts.
        </p>
      )}
    </>
  );
}

function NameDisplayPicker(
  props: Readonly<{
    value: NameDisplayMode;
    onChange: (mode: NameDisplayMode) => void;
  }>,
) {
  const options: { mode: NameDisplayMode; label: string }[] = [
    { mode: 'username', label: 'Username' },
    { mode: 'nickname', label: 'Display name' },
    { mode: 'both', label: 'Both' },
  ];
  return (
    <div className="field">
      <span>Name display</span>
      <div className="pill-row">
        {options.map((o) => (
          <button
            key={o.mode}
            type="button"
            className={props.value === o.mode ? 'pill active' : 'pill'}
            onClick={() => props.onChange(o.mode)}>
            {o.label}
          </button>
        ))}
      </div>
      <p className="muted note">
        How people appear in chat, gifts, events, and push alerts. Matching
        still uses @username.
      </p>
    </div>
  );
}

function DiamondSettingsBlock(
  props: Readonly<{
    mode: 'global' | 'stream';
    state: EditorState;
    gDiamond: GiftAlertRule | undefined;
    inheriting: boolean;
    notifyEffective: boolean;
    patch: (partial: Partial<EditorState>) => void;
  }>,
) {
  const { state, mode, gDiamond } = props;
  return (
    <div className="settings-block">
      <SwitchField
        label="Diamond threshold alerts"
        checked={props.notifyEffective}
        hint={props.inheriting ? 'using global' : null}
        onChange={(checked) =>
          props.patch({
            notifyDiamonds: checked,
            minDiamonds:
              state.minDiamonds || String(gDiamond?.minDiamondValue ?? 100),
          })
        }
      />
      {props.notifyEffective ? (
        <label className="field nested">
          <span>Min diamonds spent</span>
          <input
            type="number"
            min={1}
            value={state.minDiamonds}
            placeholder={numberPlaceholder(
              mode,
              gDiamond?.minDiamondValue,
              100,
            )}
            onChange={(e) =>
              props.patch({
                minDiamonds: e.target.value,
                notifyDiamonds: state.notifyDiamonds ?? props.notifyEffective,
              })
            }
          />
        </label>
      ) : null}
    </div>
  );
}

function GiftTypeSettingsBlock(
  props: Readonly<{
    mode: 'global' | 'stream';
    state: EditorState;
    gNamed: GiftAlertRule[];
    inheriting: boolean;
    notifyEffective: boolean;
    catalogQuery: string;
    setCatalogQuery: (v: string) => void;
    onToggleKey: (key: string) => void;
    patch: (partial: Partial<EditorState>) => void;
  }>,
) {
  const globalNames = props.gNamed
    .map((r) => r.giftName)
    .filter(Boolean)
    .join(', ');
  return (
    <div className="settings-block">
      <SwitchField
        label="Gift type alerts"
        checked={props.notifyEffective}
        hint={props.inheriting ? 'using global' : null}
        onChange={(checked) => props.patch({ notifyGifts: checked })}
      />
      {props.notifyEffective ? (
        <div className="field nested">
          <span>Important gifts</span>
          {props.mode === 'stream' && props.state.enabledGiftKeys.size === 0 ? (
            <p className="muted">
              Leave empty to use global
              {globalNames ? ` (${globalNames})` : ''}.
            </p>
          ) : null}
          <GiftPicker
            catalogGifts={props.state.catalogGifts}
            catalogQuery={props.catalogQuery}
            enabledGiftKeys={props.state.enabledGiftKeys}
            onQueryChange={props.setCatalogQuery}
            onToggleKey={props.onToggleKey}
          />
        </div>
      ) : null}
    </div>
  );
}

function HighlightSettingsBlock(
  props: Readonly<{
    mode: 'global' | 'stream';
    state: EditorState;
    global?: GlobalSettings | null;
    highlightRecentEffective: boolean;
    patch: (partial: Partial<EditorState>) => void;
  }>,
) {
  const { state, mode, global } = props;
  return (
    <>
      <label className="field">
        <span>Flagged chat keywords (one per line)</span>
        <textarea
          rows={3}
          value={state.keywordsText}
          onChange={(e) => props.patch({ keywordsText: e.target.value })}
          placeholder={listPlaceholder(
            mode,
            global?.chatKeywordFlags,
            'spam\nscam',
            'Leave blank to use global',
          )}
        />
      </label>
      <label className="field">
        <span>Always highlight usernames (one per line)</span>
        <textarea
          rows={3}
          value={state.highlightUsersText}
          onChange={(e) => props.patch({ highlightUsersText: e.target.value })}
          placeholder={listPlaceholder(
            mode,
            global?.chatHighlights.highlightUsernames,
            'vip_user\ncohost',
            'Leave blank to use global',
          )}
        />
      </label>
      <label className="check-field">
        <input
          type="checkbox"
          checked={props.highlightRecentEffective}
          onChange={(e) =>
            props.patch({ highlightRecentGifters: e.target.checked })
          }
        />
        <span>
          Highlight chat from recent gifters
          {mode === 'stream' && state.highlightRecentGifters == null ? (
            <span className="muted"> · using global</span>
          ) : null}
        </span>
      </label>
      <div className="row">
        <label className="field grow">
          <span>Gifter min diamonds spent</span>
          <input
            type="number"
            min={1}
            value={state.recentGifterMinDiamonds}
            placeholder={numberPlaceholder(
              mode,
              global?.chatHighlights.recentGifterMinDiamonds,
              1,
            )}
            onChange={(e) =>
              props.patch({ recentGifterMinDiamonds: e.target.value })
            }
          />
        </label>
        <label className="field grow">
          <span>Window (seconds)</span>
          <input
            type="number"
            min={10}
            value={state.recentGifterWindowSeconds}
            placeholder={numberPlaceholder(
              mode,
              global?.chatHighlights.recentGifterWindowSeconds,
              120,
            )}
            onChange={(e) =>
              props.patch({ recentGifterWindowSeconds: e.target.value })
            }
          />
        </label>
      </div>
    </>
  );
}

function AlertSettingsFields(
  props: Readonly<{
    mode: 'global' | 'stream';
    state: EditorState;
    global?: GlobalSettings | null;
    catalogQuery: string;
    setCatalogQuery: (v: string) => void;
    patch: (partial: Partial<EditorState>) => void;
  }>,
) {
  const { state, global, mode } = props;
  const gDiamond = global?.giftAlertRules.find(isDiamondRule);
  const gNamed = namedGiftRules(global?.giftAlertRules ?? []);
  const notifyDiamondsEffective =
    state.notifyDiamonds ?? gDiamond?.notify !== false;
  const notifyGiftsEffective =
    state.notifyGifts ??
    (gNamed.length === 0 || gNamed.some((r) => r.notify !== false));
  const highlightRecentEffective =
    state.highlightRecentGifters ??
    global?.chatHighlights.highlightRecentGifters ??
    true;

  function toggleGiftKey(key: string) {
    const next = new Set(state.enabledGiftKeys);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    props.patch({
      enabledGiftKeys: next,
      notifyGifts: state.notifyGifts ?? notifyGiftsEffective,
    });
  }

  return (
    <>
      <DiamondSettingsBlock
        mode={mode}
        state={state}
        gDiamond={gDiamond}
        inheriting={mode === 'stream' && state.notifyDiamonds == null}
        notifyEffective={notifyDiamondsEffective}
        patch={props.patch}
      />
      <GiftTypeSettingsBlock
        mode={mode}
        state={state}
        gNamed={gNamed}
        inheriting={mode === 'stream' && state.notifyGifts == null}
        notifyEffective={notifyGiftsEffective}
        catalogQuery={props.catalogQuery}
        setCatalogQuery={props.setCatalogQuery}
        onToggleKey={toggleGiftKey}
        patch={props.patch}
      />
      <HighlightSettingsBlock
        mode={mode}
        state={state}
        global={global}
        highlightRecentEffective={highlightRecentEffective}
        patch={props.patch}
      />
    </>
  );
}

export function StreamsPanel(
  props: Readonly<{
    streams: StreamRow[];
    selected: string | null;
    newStream: string;
    busy: boolean;
    onNewStreamChange: (v: string) => void;
    onSelect: (id: string) => void;
    onAdd: () => void;
    onCheckIn: (id: string) => void;
    onCheckOut: (id: string) => void;
    onStopAll: (id: string) => void;
    onRemove: (id: string) => void;
    onUnauthorized: () => void;
    onStreamSettingsSaved: (streamId: string) => void;
    withBusy: (fn: () => Promise<void>) => Promise<void>;
  }>,
) {
  const [settingsStreamId, setSettingsStreamId] = useState<string | null>(null);
  const [globalOpen, setGlobalOpen] = useState(true);

  return (
    <section className="panel">
      <h1>Streams</h1>
      <div className="global-defaults-card">
        <div className="row tight">
          <h2 className="settings-section" style={{ margin: 0, flex: 1 }}>
            Global defaults
          </h2>
          <button
            type="button"
            className={globalOpen ? 'primary' : undefined}
            disabled={props.busy}
            onClick={() => setGlobalOpen((v) => !v)}>
            {globalOpen ? 'Close' : 'Edit'}
          </button>
        </div>
        <p className="muted note">
          Apply to every stream unless that stream overrides a field. Leave
          stream fields blank to inherit.
        </p>
        {globalOpen ? (
          <StreamSettingsEditor
            mode="global"
            busy={props.busy}
            withBusy={props.withBusy}
            onUnauthorized={props.onUnauthorized}
            onSaved={() => props.onStreamSettingsSaved('')}
          />
        ) : null}
      </div>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          props.onAdd();
        }}>
        <input
          value={props.newStream}
          onChange={(e) => props.onNewStreamChange(e.target.value)}
          placeholder="tiktok username"
          autoCapitalize="off"
          autoCorrect="off"
        />
        <button type="submit" disabled={props.busy || !props.newStream.trim()}>
          Add
        </button>
      </form>
      <ul className="list">
        {props.streams.map((s) => {
          const settingsOpen = settingsStreamId === s.streamId;
          return (
            <li key={s.streamId} className="list-item">
              <span className="stream-btn">
                <span>@{s.streamId}</span>
                <span className="muted">{checkInLabel(s)}</span>
              </span>
              <div className="row tight">
                {s.youAreWatching ? (
                  <button
                    type="button"
                    disabled={props.busy}
                    onClick={() => props.onCheckOut(s.streamId)}>
                    Check out
                  </button>
                ) : (
                  <button
                    type="button"
                    className="primary"
                    disabled={props.busy}
                    onClick={() => props.onCheckIn(s.streamId)}>
                    Check in
                  </button>
                )}
                {s.isCheckedIn && (s.watcherCount > 1 || !s.youAreWatching) ? (
                  <button
                    type="button"
                    className="danger"
                    disabled={props.busy}
                    onClick={() => props.onStopAll(s.streamId)}>
                    Stop all
                  </button>
                ) : null}
                <button
                  type="button"
                  className={settingsOpen ? 'primary' : undefined}
                  disabled={props.busy}
                  onClick={() =>
                    setSettingsStreamId((prev) =>
                      prev === s.streamId ? null : s.streamId,
                    )
                  }>
                  {settingsOpen ? 'Close' : 'Settings'}
                </button>
                <button
                  type="button"
                  className="danger"
                  disabled={props.busy}
                  onClick={() => props.onRemove(s.streamId)}>
                  Remove
                </button>
              </div>
              {settingsOpen ? (
                <StreamSettingsEditor
                  mode="stream"
                  streamId={s.streamId}
                  busy={props.busy}
                  withBusy={props.withBusy}
                  onUnauthorized={props.onUnauthorized}
                  onSaved={() => props.onStreamSettingsSaved(s.streamId)}
                />
              ) : null}
            </li>
          );
        })}
      </ul>
      {props.streams.length === 0 ? (
        <p className="muted">Add a TikTok username to get started.</p>
      ) : null}
    </section>
  );
}

async function loadGlobalEditor(): Promise<{
  global: GlobalSettings;
  state: EditorState;
}> {
  const g = await getGlobalSettings();
  const catalog = await loadCatalogWithExtras(namedGiftRules(g.giftAlertRules));
  return {
    global: g,
    state: stateFromAlertSettings(g, catalog, g.nameDisplayMode),
  };
}

async function loadStreamEditor(streamId: string): Promise<{
  global: GlobalSettings;
  state: EditorState;
}> {
  const cfg = await getConfig(streamId);
  const g = cfg.global ?? (await getGlobalSettings());
  const overrideNamed = namedGiftRules(cfg.overrides?.giftAlertRules ?? []);
  const globalNamed = namedGiftRules(g.giftAlertRules);
  const catalog = await loadCatalogWithExtras([
    ...overrideNamed,
    ...globalNamed,
  ]);
  return { global: g, state: stateFromOverrides(cfg, catalog) };
}

function StreamSettingsEditor(
  props: Readonly<{
    mode: 'global' | 'stream';
    streamId?: string;
    busy: boolean;
    withBusy: (fn: () => Promise<void>) => Promise<void>;
    onUnauthorized: () => void;
    onSaved: () => void;
  }>,
) {
  const { mode, streamId, onUnauthorized, onSaved } = props;
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [state, setState] = useState<EditorState>(() => emptyEditorState());
  const [global, setGlobal] = useState<GlobalSettings | null>(null);
  const [catalogQuery, setCatalogQuery] = useState('');
  const [saveStatus, setSaveStatus] = useState<
    'idle' | 'saving' | 'saved' | 'error'
  >('idle');
  const [saveError, setSaveError] = useState<string | null>(null);

  const hydratedRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stateRef = useRef(state);
  const globalRef = useRef(global);
  const modeRef = useRef(mode);
  const streamIdRef = useRef(streamId);
  stateRef.current = state;
  globalRef.current = global;
  modeRef.current = mode;
  streamIdRef.current = streamId;

  function flushPendingSave() {
    if (!saveTimerRef.current) return;
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = null;
    if (!hydratedRef.current) return;
    const next = stateRef.current;
    const m = modeRef.current;
    const id = streamIdRef.current;
    if (m === 'global') {
      void putGlobalSettings(buildGlobalPayload(next))
        .then(onSaved)
        .catch(() => undefined);
      return;
    }
    if (id) {
      void putConfig(id, buildStreamOverridePayload(next, globalRef.current))
        .then(onSaved)
        .catch(() => undefined);
    }
  }

  useEffect(() => {
    let cancelled = false;
    hydratedRef.current = false;
    setLoading(true);
    setLoadError(null);
    setSaveStatus('idle');
    setSaveError(null);

    void loadEditorForMode(mode, streamId)
      .then((loaded) => {
        if (cancelled) return;
        setGlobal(loaded.global);
        setState(loaded.state);
        hydratedRef.current = true;
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (isUnauthorized(err)) {
          onUnauthorized();
          return;
        }
        setLoadError(errorMessage(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      flushPendingSave();
    };
  }, [mode, streamId, onUnauthorized]);

  async function persist(next: EditorState) {
    setSaveStatus('saving');
    setSaveError(null);
    try {
      if (mode === 'global') {
        setGlobal(await putGlobalSettings(buildGlobalPayload(next)));
      } else if (streamId) {
        await putConfig(
          streamId,
          buildStreamOverridePayload(next, globalRef.current),
        );
      }
      setSaveStatus('saved');
      onSaved();
    } catch (err) {
      if (isUnauthorized(err)) {
        onUnauthorized();
        return;
      }
      setSaveStatus('error');
      setSaveError(errorMessage(err));
    }
  }

  function scheduleSave(next: EditorState) {
    if (!hydratedRef.current) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    setSaveStatus('saving');
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      void persist(next);
    }, AUTOSAVE_MS);
  }

  function patch(partial: Partial<EditorState>) {
    setState((prev) => {
      const next = { ...prev, ...partial };
      scheduleSave(next);
      return next;
    });
  }

  async function resetToGlobal() {
    if (!streamId) return;
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    hydratedRef.current = false;
    await putConfig(streamId, { clearOverrides: true });
    const loaded = await loadStreamEditor(streamId);
    setGlobal(loaded.global);
    setState(loaded.state);
    hydratedRef.current = true;
    setSaveStatus('saved');
    onSaved();
  }

  const ready = !loading && !loadError;
  const statusText = autosaveLabel(saveStatus);

  return (
    <div className="stream-settings">
      <div className="settings-section-row">
        <h3 className="settings-section">
          {mode === 'global'
            ? 'Alerts, highlights & names'
            : 'Stream overrides'}
        </h3>
        {ready && statusText ? (
          <span className="muted autosave-status" aria-live="polite">
            {statusText}
          </span>
        ) : null}
      </div>
      {mode === 'stream' ? (
        <p className="muted note">
          Blank fields use global defaults. Changes save automatically.
        </p>
      ) : (
        <p className="muted note">Changes save automatically.</p>
      )}
      {loading ? <p className="muted">Loading settings…</p> : null}
      {loadError ? <p className="banner error">{loadError}</p> : null}
      {saveError ? <p className="banner error">{saveError}</p> : null}
      {ready ? (
        <>
          {mode === 'global' ? (
            <NameDisplayPicker
              value={state.nameDisplayMode}
              onChange={(nameDisplayMode) => patch({ nameDisplayMode })}
            />
          ) : null}
          <AlertSettingsFields
            mode={mode}
            state={state}
            global={global}
            catalogQuery={catalogQuery}
            setCatalogQuery={setCatalogQuery}
            patch={patch}
          />
          {mode === 'stream' && streamId ? (
            <button
              type="button"
              disabled={props.busy || saveStatus === 'saving'}
              onClick={() => void props.withBusy(resetToGlobal)}>
              Reset to global
            </button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

async function loadEditorForMode(
  mode: 'global' | 'stream',
  streamId: string | undefined,
): Promise<{ global: GlobalSettings; state: EditorState }> {
  if (mode === 'global') return loadGlobalEditor();
  if (!streamId) throw new Error('streamId required');
  return loadStreamEditor(streamId);
}
