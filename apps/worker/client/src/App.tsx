import {
  DEFAULT_NAME_DISPLAY_MODE,
  formatGiftTarget,
  formatPersonLabel,
  giftDiamondSpend,
  type ChatHighlightConfig,
  type ChatLogItem,
  type ChatUserSignals,
  type ConnectionStatus,
  type GiftLogItem,
  type LiveFeed,
  type NameDisplayMode,
  type RoomEventType,
  type RoomLogItem,
} from '@tiktok-mod/shared';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type SubmitEvent,
} from 'react';
import {
  addStream,
  checkIn,
  checkOut,
  DEFAULT_CHAT_HIGHLIGHTS,
  fetchPublicConfig,
  fetchQuota,
  getLiveFeed,
  getPasscode,
  listStreams,
  markDone,
  markGiftDone,
  markGiftPending,
  markGiftsDone,
  markGiftsPending,
  pingPresence,
  removeStream,
  setPasscode,
  statusLabel,
  subscribePush,
  testPush,
  urlBase64ToUint8Array,
  type QuotaSnapshot,
} from './api';
import { StreamsPanel, type StreamRow } from './StreamSettings';

type Tab = 'live' | 'streams' | 'settings';

type BootState =
  | { phase: 'loading' }
  | { phase: 'locked'; vapidPublicKey: string | null }
  | {
      phase: 'ready';
      passcodeRequired: boolean;
      vapidPublicKey: string | null;
    }
  | { phase: 'error'; message: string };

const EVENT_FILTER_TYPES: { type: RoomEventType; label: string }[] = [
  { type: 'member', label: 'Joins' },
  { type: 'follow', label: 'Follows' },
  { type: 'share', label: 'Shares' },
  { type: 'subscribe', label: 'Subs' },
];

const EVENT_FILTER_KEY = (streamId: string) =>
  `live-mod:event-filters:${streamId}`;

function defaultEventFilters(): Set<RoomEventType> {
  return new Set(EVENT_FILTER_TYPES.map((t) => t.type));
}

function loadEventFilters(streamId: string): Set<RoomEventType> {
  const allowed = new Set(EVENT_FILTER_TYPES.map((t) => t.type));
  try {
    const raw = localStorage.getItem(EVENT_FILTER_KEY(streamId));
    if (!raw) return defaultEventFilters();
    return new Set(
      (JSON.parse(raw) as RoomEventType[]).filter((t) => allowed.has(t)),
    );
  } catch {
    return defaultEventFilters();
  }
}

function saveEventFilters(streamId: string, types: Set<RoomEventType>) {
  localStorage.setItem(EVENT_FILTER_KEY(streamId), JSON.stringify([...types]));
}

const GIFT_MIN_DIAMONDS_KEY = (streamId: string) =>
  `live-mod:gift-min-diamonds:${streamId}`;

const GIFT_TYPE_FILTER_KEY = (streamId: string) =>
  `live-mod:gift-type-filters:${streamId}`;

function loadGiftMinDiamonds(streamId: string): number {
  try {
    const raw = localStorage.getItem(GIFT_MIN_DIAMONDS_KEY(streamId));
    if (raw == null || raw === '') return 0;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

function saveGiftMinDiamonds(streamId: string, value: number) {
  localStorage.setItem(GIFT_MIN_DIAMONDS_KEY(streamId), String(value));
}

function loadGiftTypeFilters(
  streamId: string,
  enabledNames: string[],
): Set<string> {
  const allowed = enabledNames.map((n) => n.toLowerCase());
  try {
    const raw = localStorage.getItem(GIFT_TYPE_FILTER_KEY(streamId));
    if (!raw) return new Set(allowed);
    const parsed = JSON.parse(raw) as
      | string[]
      | { on?: string[]; known?: string[] };
    if (Array.isArray(parsed)) {
      const saved = new Set(parsed.map((n) => n.toLowerCase()));
      return new Set(allowed.filter((n) => saved.has(n)));
    }
    const on = new Set((parsed.on ?? []).map((n) => n.toLowerCase()));
    const known = new Set((parsed.known ?? []).map((n) => n.toLowerCase()));
    return new Set(allowed.filter((n) => on.has(n) || !known.has(n)));
  } catch {
    return new Set(allowed);
  }
}

function saveGiftTypeFilters(
  streamId: string,
  types: Set<string>,
  enabledNames: string[],
) {
  localStorage.setItem(
    GIFT_TYPE_FILTER_KEY(streamId),
    JSON.stringify({
      on: [...types],
      known: enabledNames.map((n) => n.toLowerCase()),
    }),
  );
}

function giftMatchesFeedFilter(
  item: GiftLogItem,
  minDiamonds: number,
  activeTypes: Set<string>,
): boolean {
  if (giftDiamondSpend(item.diamondValue, item.giftCount) < minDiamonds) {
    return false;
  }
  if (activeTypes.size === 0) return true;
  const name = item.giftName?.toLowerCase();
  return Boolean(name && activeTypes.has(name));
}

type ChatFilterKind = 'flagged' | 'watch' | 'gifter' | 'mod' | 'sub' | 'follow';

const CHAT_FILTER_TYPES: { type: ChatFilterKind; label: string }[] = [
  { type: 'flagged', label: 'Flagged' },
  { type: 'watch', label: 'Watch' },
  { type: 'gifter', label: 'Gifted' },
  { type: 'mod', label: 'Mods' },
  { type: 'sub', label: 'Subs' },
  { type: 'follow', label: 'Followers' },
];

const CHAT_FILTER_KEY = (streamId: string) =>
  `live-mod:chat-filters:${streamId}`;

function loadChatFilters(streamId: string): Set<ChatFilterKind> {
  const allowed = new Set(CHAT_FILTER_TYPES.map((t) => t.type));
  try {
    const raw = localStorage.getItem(CHAT_FILTER_KEY(streamId));
    if (!raw) return new Set();
    return new Set(
      (JSON.parse(raw) as ChatFilterKind[]).filter((t) => allowed.has(t)),
    );
  } catch {
    return new Set();
  }
}

function saveChatFilters(streamId: string, types: Set<ChatFilterKind>) {
  localStorage.setItem(CHAT_FILTER_KEY(streamId), JSON.stringify([...types]));
}

function chatMatchesFeedFilter(
  item: ChatLogItem,
  filters: Set<ChatFilterKind>,
  watchlist: Set<string>,
  gifts: GiftLogItem[],
  highlights: ChatHighlightConfig,
): boolean {
  if (filters.size === 0) return true;
  const uname = item.username?.toLowerCase() ?? '';
  if (filters.has('flagged') && item.flaggedKeyword) return true;
  if (filters.has('watch') && uname && watchlist.has(uname)) return true;
  if (filters.has('gifter') && uname) {
    const gifters = recentGifterUsernames(
      gifts,
      highlights,
      item.createdAt,
      true,
    );
    if (gifters.has(uname)) return true;
  }
  const s = item.userSignals;
  if (filters.has('mod') && s?.isModerator) return true;
  if (filters.has('sub') && s?.isSubscriber) return true;
  if (filters.has('follow') && s?.isFollower) return true;
  return false;
}

const EMPTY_FEED: LiveFeed = {
  streamId: '',
  status: 'idle',
  statusDetail: null,
  isCheckedIn: false,
  chatHighlights: DEFAULT_CHAT_HIGHLIGHTS,
  nameDisplayMode: DEFAULT_NAME_DISPLAY_MODE,
  enabledGiftNames: [],
  chat: [],
  events: [],
  gifts: [],
};

const LIVE_POLL_MS = 2500;
const PRESENCE_POLL_MS = 10_000;
/** Matches the server-side log caps, so trimmed rows fall off the client too. */
const FEED_KEEP = 200;

function mergeFeed(prev: LiveFeed, next: LiveFeed): LiveFeed {
  if (!next.incremental || prev.streamId !== next.streamId) return next;
  const chat = mergeLog(prev.chat, next.chat);
  const events = mergeLog(prev.events, next.events);
  const gifts = mergeLog(prev.gifts, next.gifts);
  const unchanged =
    chat === prev.chat &&
    events === prev.events &&
    gifts === prev.gifts &&
    sameFeedMeta(prev, next);
  return unchanged ? prev : { ...next, chat, events, gifts };
}

function mergeLog<T extends { id: string; createdAt: number }>(
  prev: T[],
  incoming: T[],
): T[] {
  if (incoming.length === 0) return prev;
  const byId = new Map(prev.map((item) => [item.id, item]));
  for (const item of incoming) byId.set(item.id, item);
  return [...byId.values()]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, FEED_KEEP);
}

/** Everything outside the logs, so a quiet poll can keep the previous state. */
function sameFeedMeta(a: LiveFeed, b: LiveFeed): boolean {
  return (
    a.status === b.status &&
    a.statusDetail === b.statusDetail &&
    a.isCheckedIn === b.isCheckedIn &&
    a.nameDisplayMode === b.nameDisplayMode &&
    a.enabledGiftNames.join('\n') === b.enabledGiftNames.join('\n') &&
    JSON.stringify(a.chatHighlights) === JSON.stringify(b.chatHighlights)
  );
}

export function App() {
  const [boot, setBoot] = useState<BootState>({ phase: 'loading' });

  useEffect(() => {
    void (async () => {
      try {
        const cfg = await fetchPublicConfig();
        if (!cfg.passcodeRequired) {
          setBoot({
            phase: 'ready',
            passcodeRequired: false,
            vapidPublicKey: cfg.vapidPublicKey,
          });
          return;
        }
        const stored = getPasscode();
        if (stored) {
          try {
            await listStreams();
            setBoot({
              phase: 'ready',
              passcodeRequired: true,
              vapidPublicKey: cfg.vapidPublicKey,
            });
            return;
          } catch {
            setPasscode('');
          }
        }
        setBoot({ phase: 'locked', vapidPublicKey: cfg.vapidPublicKey });
      } catch (err) {
        setBoot({
          phase: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  }, []);

  if (boot.phase === 'loading') {
    return (
      <div className="app">
        <p className="muted">Loading…</p>
      </div>
    );
  }

  if (boot.phase === 'error') {
    return (
      <div className="app">
        <header className="header">
          <div>
            <p className="brand">Live Mod</p>
            <p className="sub">TTMM - TikTok Mobile Mod</p>
          </div>
        </header>
        <div className="banner error">{boot.message}</div>
      </div>
    );
  }

  if (boot.phase === 'locked') {
    return (
      <PasscodeGate
        vapidPublicKey={boot.vapidPublicKey}
        onUnlocked={(vapidPublicKey) =>
          setBoot({
            phase: 'ready',
            passcodeRequired: true,
            vapidPublicKey,
          })
        }
      />
    );
  }

  return (
    <ModApp
      passcodeRequired={boot.passcodeRequired}
      vapidPublicKey={boot.vapidPublicKey}
      onLock={() =>
        setBoot({
          phase: 'locked',
          vapidPublicKey: boot.vapidPublicKey,
        })
      }
    />
  );
}

function PasscodeGate(
  props: Readonly<{
    vapidPublicKey: string | null;
    onUnlocked: (vapidPublicKey: string | null) => void;
  }>,
) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setPasscode(value.trim());
    try {
      await listStreams();
      props.onUnlocked(props.vapidPublicKey);
    } catch {
      setPasscode('');
      setError('Incorrect passcode.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app">
      <header className="header">
        <div>
          <p className="brand">Live Mod</p>
          <p className="sub">Enter the mod passcode to continue</p>
        </div>
      </header>
      <section className="panel gate">
        <form onSubmit={(e) => void submit(e)}>
          <label className="field">
            <span>Passcode</span>
            <input
              type="password"
              autoFocus
              autoComplete="current-password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="shared passcode"
            />
          </label>
          {error ? <div className="banner error">{error}</div> : null}
          <button
            type="submit"
            className="primary"
            disabled={busy || !value.trim()}>
            {busy ? 'Checking…' : 'Unlock'}
          </button>
        </form>
      </section>
    </div>
  );
}

function ModApp(
  props: Readonly<{
    passcodeRequired: boolean;
    vapidPublicKey: string | null;
    onLock: () => void;
  }>,
) {
  const [tab, setTab] = useState<Tab>('live');
  const [streams, setStreams] = useState<StreamRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [feed, setFeed] = useState<LiveFeed>(EMPTY_FEED);
  const [newStream, setNewStream] = useState('');
  const [passcodeInput, setPasscodeInput] = useState(getPasscode());
  const [pushStatus, setPushStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [quota, setQuota] = useState<QuotaSnapshot | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const feedCursor = useRef<number | null>(null);
  const selectedRef = useRef(selected);

  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  const selectedStream = useMemo(
    () => streams.find((s) => s.streamId === selected) ?? null,
    [streams, selected],
  );

  const handleUnauthorized = useCallback(() => {
    setPasscode('');
    setStreams([]);
    feedCursor.current = null;
    setFeed(EMPTY_FEED);
    props.onLock();
  }, [props]);

  const refreshStreams = useCallback(async () => {
    try {
      const data = await listStreams();
      setStreams(data.streams);
      setSelected((prev) => {
        if (prev && data.streams.some((s) => s.streamId === prev)) return prev;
        const checked = data.streams.find((s) => s.isCheckedIn);
        return checked?.streamId ?? data.streams[0]?.streamId ?? null;
      });
    } catch (err) {
      if (isUnauthorized(err)) {
        handleUnauthorized();
        return;
      }
      throw err;
    }
  }, [handleUnauthorized]);

  const refreshLive = useCallback(
    async (full = false) => {
      if (!selected) {
        feedCursor.current = null;
        setFeed(EMPTY_FEED);
        return;
      }
      if (full) feedCursor.current = null;
      try {
        const next = await getLiveFeed(selected, feedCursor.current);
        if (selectedRef.current !== selected) return;
        feedCursor.current = next.cursor ?? null;
        setFeed((prev) => mergeFeed(prev, next));
      } catch (err) {
        if (isUnauthorized(err)) {
          handleUnauthorized();
          return;
        }
        throw err;
      }
    },
    [selected, handleUnauthorized],
  );

  const tick = useCallback(async () => {
    try {
      await pingPresence(selected ? [selected] : []);
    } catch (err) {
      if (isUnauthorized(err)) {
        handleUnauthorized();
        return;
      }
    }
    await refreshStreams().catch(() => undefined);
  }, [selected, handleUnauthorized, refreshStreams]);

  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get('stream');
    if (fromUrl) {
      setSelected(fromUrl);
      setTab('live');
    }
    void refreshStreams().catch((err: unknown) =>
      setError(err instanceof Error ? err.message : String(err)),
    );
  }, [refreshStreams]);

  // Presence lasts 20s server-side and the stream list barely moves, so this
  // doesn't need the live feed's cadence.
  useEffect(() => {
    const run = () => {
      if (document.hidden) return;
      void tick().catch(() => undefined);
    };
    run();
    const id = window.setInterval(run, PRESENCE_POLL_MS);
    return () => window.clearInterval(id);
  }, [tick]);

  // Polling only asks for rows past the cursor, and a hidden tab asks for
  // nothing at all — alerts still arrive as push notifications.
  useEffect(() => {
    const run = (full: boolean) => {
      if (document.hidden) return;
      void refreshLive(full).catch(() => undefined);
    };
    run(true);
    const id = window.setInterval(() => run(false), LIVE_POLL_MS);
    const onVisibility = () => run(true);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [refreshLive]);

  useEffect(() => {
    let cancelled = false;
    async function loadQuota() {
      if (document.hidden) return;
      try {
        const data = await fetchQuota();
        if (!cancelled) setQuota(data);
      } catch (err) {
        if (isUnauthorized(err)) {
          handleUnauthorized();
        }
      }
    }
    void loadQuota();
    const poll = window.setInterval(() => void loadQuota(), 60_000);
    const clock = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(poll);
      window.clearInterval(clock);
    };
  }, [handleUnauthorized]);

  async function withBusy(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      if (isUnauthorized(err)) {
        handleUnauthorized();
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function enablePush() {
    setPushStatus(await ensureWebPush(props.vapidPublicKey));
  }

  const status: ConnectionStatus = selectedStream?.isCheckedIn
    ? feed.status
    : 'idle';

  return (
    <div className="app">
      <header className="header">
        <div>
          <p className="brand">Live Mod</p>
        </div>
        <StatusChip
          status={status}
          checkedIn={Boolean(selectedStream?.isCheckedIn)}
        />
      </header>

      {error ? <div className="banner error">{error}</div> : null}
      <QuotaBanner quota={quota} now={now} />

      <nav className="tabs">
        {(['live', 'streams', 'settings'] as Tab[]).map((t) => (
          <button
            key={t}
            className={tab === t ? 'tab active' : 'tab'}
            type="button"
            onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </nav>

      <main className="main">
        {tab === 'live' ? (
          <LivePanel
            selected={selected}
            streams={streams}
            feed={feed}
            busy={busy}
            onSelect={setSelected}
            onDone={(queueItemId) =>
              void withBusy(async () => {
                if (!selected) return;
                await markDone(selected, queueItemId);
                await refreshLive();
              })
            }
            onGiftDone={(giftId) =>
              void withBusy(async () => {
                if (!selected) return;
                await markGiftDone(selected, giftId);
                await refreshLive();
              })
            }
            onGiftUndo={(giftId) =>
              void withBusy(async () => {
                if (!selected) return;
                await markGiftPending(selected, giftId);
                await refreshLive();
              })
            }
            onGiftDoneAll={(giftIds) =>
              void withBusy(async () => {
                if (!selected || giftIds.length === 0) return;
                await markGiftsDone(selected, giftIds);
                await refreshLive();
              })
            }
            onGiftUndoAll={(giftIds) =>
              void withBusy(async () => {
                if (!selected || giftIds.length === 0) return;
                await markGiftsPending(selected, giftIds);
                await refreshLive();
              })
            }
          />
        ) : null}

        {tab === 'streams' ? (
          <StreamsPanel
            streams={streams}
            selected={selected}
            newStream={newStream}
            busy={busy}
            onNewStreamChange={setNewStream}
            onSelect={(id) => {
              setSelected(id);
              setTab('live');
            }}
            onAdd={() =>
              void withBusy(async () => {
                await addStream(newStream);
                setNewStream('');
                await refreshStreams();
              })
            }
            onCheckIn={(id) =>
              void withBusy(async () => {
                // Prompt first while the tap is still a user gesture.
                const permission =
                  'Notification' in window ? Notification.permission : 'denied';
                if (permission === 'default') {
                  const pushMsg = await ensureWebPush(
                    props.vapidPublicKey,
                    true,
                  ).catch(() => '');
                  if (pushMsg) setPushStatus(pushMsg);
                } else if (permission === 'granted') {
                  void ensureWebPush(props.vapidPublicKey, true).catch(
                    () => undefined,
                  );
                }
                await checkIn(id);
                setSelected(id);
                setTab('live');
                await refreshStreams();
                await refreshLive();
              })
            }
            onCheckOut={(id) =>
              void withBusy(async () => {
                await checkOut(id);
                await refreshStreams();
                await refreshLive();
              })
            }
            onStopAll={(id) =>
              void withBusy(async () => {
                const ok = window.confirm(
                  `Disconnect @${id} for everyone? This stops the live watch on all devices.`,
                );
                if (!ok) return;
                await checkOut(id, { force: true });
                await refreshStreams();
                await refreshLive();
              })
            }
            onRemove={(id) =>
              void withBusy(async () => {
                await removeStream(id);
                if (selected === id) setSelected(null);
                await refreshStreams();
              })
            }
            onUnauthorized={handleUnauthorized}
            onStreamSettingsSaved={(id) => {
              if (id === selected) void refreshLive().catch(() => undefined);
            }}
            withBusy={withBusy}
          />
        ) : null}

        {tab === 'settings' ? (
          <SettingsPanel
            passcode={passcodeInput}
            passcodeRequired={props.passcodeRequired}
            pushStatus={pushStatus}
            busy={busy}
            quota={quota}
            now={now}
            onPasscodeChange={setPasscodeInput}
            onPasscodeBlur={() => setPasscode(passcodeInput)}
            onLock={() => {
              setPasscode('');
              props.onLock();
            }}
            onEnablePush={() => void enablePush()}
            onTestPush={() =>
              void withBusy(async () => {
                await testPush();
                setPushStatus('Test push sent.');
              })
            }
          />
        ) : null}
      </main>
    </div>
  );
}

function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function FeedTime(props: Readonly<{ at: number }>) {
  return <span className="feed-time">{formatClock(props.at)}</span>;
}

function statusTone(
  checkedIn: boolean,
  status: ConnectionStatus,
): 'idle' | 'live' | 'warn' {
  if (!checkedIn) return 'idle';
  if (status === 'live') return 'live';
  if (status === 'offline' || status === 'disconnected') return 'warn';
  return 'idle';
}

function StatusChip(
  props: Readonly<{ status: ConnectionStatus; checkedIn: boolean }>,
) {
  const label = !props.checkedIn ? 'Checked out' : statusLabel(props.status);
  const tone = statusTone(props.checkedIn, props.status);
  return <span className={`badge status-${tone}`}>{label}</span>;
}

function LivePanel(
  props: Readonly<{
    selected: string | null;
    streams: StreamRow[];
    feed: LiveFeed;
    busy: boolean;
    onSelect: (streamId: string) => void;
    onDone: (queueItemId: string) => void;
    onGiftDone: (giftId: string) => void;
    onGiftUndo: (giftId: string) => void;
    onGiftDoneAll: (giftIds: string[]) => void;
    onGiftUndoAll: (giftIds: string[]) => void;
  }>,
) {
  const [eventFilters, setEventFilters] = useState<Set<RoomEventType>>(() =>
    defaultEventFilters(),
  );
  const [chatFilters, setChatFilters] = useState<Set<ChatFilterKind>>(
    () => new Set(),
  );
  const [giftMinDiamondsText, setGiftMinDiamondsText] = useState('0');
  const [giftTypeFilters, setGiftTypeFilters] = useState<Set<string>>(
    () => new Set(),
  );
  const [bulkUndoIds, setBulkUndoIds] = useState<string[]>([]);

  const checkedInStreams = useMemo(
    () => props.streams.filter((s) => s.isCheckedIn),
    [props.streams],
  );

  const enabledGiftNames = props.feed.enabledGiftNames ?? [];
  const enabledGiftKey = enabledGiftNames
    .map((n) => n.toLowerCase())
    .join('\0');

  useEffect(() => {
    if (!props.selected) return;
    setEventFilters(loadEventFilters(props.selected));
    setChatFilters(loadChatFilters(props.selected));
    setGiftMinDiamondsText(String(loadGiftMinDiamonds(props.selected)));
    const names = enabledGiftKey ? enabledGiftKey.split('\0') : [];
    setGiftTypeFilters(loadGiftTypeFilters(props.selected, names));
  }, [props.selected, enabledGiftKey]);

  useEffect(() => {
    setBulkUndoIds([]);
  }, [props.selected]);

  function toggleEventType(type: RoomEventType) {
    if (!props.selected) return;
    setEventFilters((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      saveEventFilters(props.selected!, next);
      return next;
    });
  }

  function toggleChatFilter(type: ChatFilterKind) {
    if (!props.selected) return;
    setChatFilters((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      saveChatFilters(props.selected!, next);
      return next;
    });
  }

  function updateGiftMinDiamonds(raw: string) {
    if (!/^\d*$/.test(raw)) return;
    setGiftMinDiamondsText(raw);
    if (!props.selected) return;
    saveGiftMinDiamonds(props.selected, raw === '' ? 0 : Number(raw));
  }

  function toggleGiftType(name: string) {
    if (!props.selected) return;
    const key = name.toLowerCase();
    setGiftTypeFilters((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      saveGiftTypeFilters(props.selected!, next, enabledGiftNames);
      return next;
    });
  }

  function toggleAllGiftTypes() {
    if (!props.selected) return;
    const allKeys = enabledGiftNames.map((n) => n.toLowerCase());
    setGiftTypeFilters((prev) => {
      const allOn = allKeys.length > 0 && allKeys.every((k) => prev.has(k));
      const next = allOn ? new Set<string>() : new Set(allKeys);
      saveGiftTypeFilters(props.selected!, next, enabledGiftNames);
      return next;
    });
  }

  if (!props.selected) {
    return (
      <section className="panel">
        <h1>Live</h1>
        <p className="muted">Add and check in to a stream to see the feed.</p>
      </section>
    );
  }

  const highlights = props.feed.chatHighlights ?? DEFAULT_CHAT_HIGHLIGHTS;
  const watchlist = new Set(
    highlights.highlightUsernames.map((u) => u.toLowerCase()),
  );
  const filteredChat = props.feed.chat.filter((item) =>
    chatMatchesFeedFilter(
      item,
      chatFilters,
      watchlist,
      props.feed.gifts,
      highlights,
    ),
  );
  const filteredEvents = props.feed.events.filter(
    (e) => e.type === 'stream_end' || eventFilters.has(e.type),
  );
  const giftMinDiamonds =
    giftMinDiamondsText === '' ? 0 : Number(giftMinDiamondsText);
  const filteredGifts = props.feed.gifts.filter((g) =>
    giftMatchesFeedFilter(g, giftMinDiamonds, giftTypeFilters),
  );
  const importantTypes = new Set(enabledGiftNames.map((n) => n.toLowerCase()));

  return (
    <section className="panel live-panel">
      {checkedInStreams.length > 0 ? (
        <div
          className="live-stream-switcher"
          role="tablist"
          aria-label="Checked-in streams">
          <div className="pill-row live-stream-pills">
            {checkedInStreams.map((s) => {
              const active = props.selected === s.streamId;
              return (
                <button
                  key={s.streamId}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  className={active ? 'pill active' : 'pill'}
                  disabled={props.busy && !active}
                  onClick={() => props.onSelect(s.streamId)}>
                  @{s.streamId}
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <p className="muted note live-stream-switcher-empty">
          No streams checked in. Check in from Streams to watch a feed.
        </p>
      )}
      <div className="live-layout">
        <FeedColumn
          title="Gifts"
          className="feed-primary"
          empty="No gifts yet."
          headerExtra={
            <div className="gift-filters">
              <label className="gift-min-diamonds">
                <span>Min ◆</span>
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  value={giftMinDiamondsText}
                  onChange={(e) => updateGiftMinDiamonds(e.target.value)}
                />
              </label>
              {enabledGiftNames.length > 0 ? (
                <div className="pill-row">
                  <button
                    type="button"
                    className={
                      enabledGiftNames.every((n) =>
                        giftTypeFilters.has(n.toLowerCase()),
                      )
                        ? 'pill active'
                        : 'pill'
                    }
                    onClick={() => toggleAllGiftTypes()}>
                    All
                  </button>
                  {enabledGiftNames.map((name) => (
                    <button
                      key={name.toLowerCase()}
                      type="button"
                      className={
                        giftTypeFilters.has(name.toLowerCase())
                          ? 'pill active'
                          : 'pill'
                      }
                      onClick={() => toggleGiftType(name)}>
                      {name}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          }>
          <GiftList
            items={filteredGifts}
            empty={
              props.feed.gifts.length === 0
                ? 'No gifts yet.'
                : 'No matching gifts.'
            }
            importantTypes={importantTypes}
            hostUsername={props.selected}
            nameDisplayMode={
              props.feed.nameDisplayMode ?? DEFAULT_NAME_DISPLAY_MODE
            }
            busy={props.busy}
            bulkUndoIds={bulkUndoIds}
            onDone={(giftId) => {
              setBulkUndoIds([]);
              props.onGiftDone(giftId);
            }}
            onUndo={(giftId) => {
              setBulkUndoIds([]);
              props.onGiftUndo(giftId);
            }}
            onDoneAll={(giftIds) => {
              setBulkUndoIds(giftIds);
              props.onGiftDoneAll(giftIds);
            }}
            onUndoAll={() => {
              if (bulkUndoIds.length === 0) return;
              const ids = bulkUndoIds;
              setBulkUndoIds([]);
              props.onGiftUndoAll(ids);
            }}
          />
        </FeedColumn>

        <div className="live-secondary">
          <FeedColumn
            title="Chat"
            className="feed-chat"
            empty="No chat yet."
            headerExtra={
              <div className="pill-row">
                {CHAT_FILTER_TYPES.map((f) => (
                  <button
                    key={f.type}
                    type="button"
                    className={chatFilters.has(f.type) ? 'pill active' : 'pill'}
                    onClick={() => toggleChatFilter(f.type)}>
                    {f.label}
                  </button>
                ))}
              </div>
            }>
            <ChatList
              items={filteredChat}
              gifts={props.feed.gifts}
              highlights={highlights}
              nameDisplayMode={
                props.feed.nameDisplayMode ?? DEFAULT_NAME_DISPLAY_MODE
              }
              empty={
                props.feed.chat.length === 0
                  ? 'No chat yet.'
                  : 'No matching chat.'
              }
              busy={props.busy}
              onDone={props.onDone}
            />
          </FeedColumn>

          <FeedColumn
            title="Events"
            className="feed-events"
            empty="No room events yet."
            headerExtra={
              <div className="pill-row">
                {EVENT_FILTER_TYPES.map((f) => (
                  <button
                    key={f.type}
                    type="button"
                    className={
                      eventFilters.has(f.type) ? 'pill active' : 'pill'
                    }
                    onClick={() => toggleEventType(f.type)}>
                    {f.label}
                  </button>
                ))}
              </div>
            }>
            <EventList
              items={filteredEvents}
              nameDisplayMode={
                props.feed.nameDisplayMode ?? DEFAULT_NAME_DISPLAY_MODE
              }
            />
          </FeedColumn>
        </div>
      </div>
    </section>
  );
}

function FeedColumn(
  props: Readonly<{
    title: string;
    empty: string;
    className?: string;
    headerExtra?: ReactNode;
    children: ReactNode;
  }>,
) {
  return (
    <div className={`feed-col ${props.className ?? ''}`}>
      <div className="feed-col-header">
        <h2>{props.title}</h2>
        {props.headerExtra}
      </div>
      <div className="feed-scroll">{props.children}</div>
    </div>
  );
}

function recentGifterUsernames(
  gifts: GiftLogItem[],
  highlights: ChatHighlightConfig,
  atTime: number,
  enabled = highlights.highlightRecentGifters,
): Set<string> {
  const names = new Set<string>();
  if (!enabled) return names;
  const windowMs = highlights.recentGifterWindowSeconds * 1000;
  for (const g of gifts) {
    if (!g.senderUsername) continue;
    if (
      giftDiamondSpend(g.diamondValue, g.giftCount) <
      highlights.recentGifterMinDiamonds
    )
      continue;
    if (atTime - g.createdAt > windowMs || atTime < g.createdAt) continue;
    names.add(g.senderUsername.toLowerCase());
  }
  return names;
}

function ChatList(
  props: Readonly<{
    items: ChatLogItem[];
    gifts: GiftLogItem[];
    highlights: ChatHighlightConfig;
    nameDisplayMode: NameDisplayMode;
    empty?: string;
    busy: boolean;
    onDone: (queueItemId: string) => void;
  }>,
) {
  const watchlist = useMemo(
    () =>
      new Set(props.highlights.highlightUsernames.map((u) => u.toLowerCase())),
    [props.highlights.highlightUsernames],
  );

  if (props.items.length === 0) {
    return <p className="muted feed-empty">{props.empty ?? 'No chat yet.'}</p>;
  }
  return (
    <div className="feed-inner">
      {props.items.map((item) => {
        const done = item.queueStatus === 'done';
        const pending = item.queueStatus === 'pending';
        const uname = item.username?.toLowerCase() ?? '';
        const watched = Boolean(uname && watchlist.has(uname));
        const gifters = recentGifterUsernames(
          props.gifts,
          props.highlights,
          item.createdAt,
        );
        const recentGifter = Boolean(uname && gifters.has(uname));
        const classes = [
          'feed-line',
          item.flaggedKeyword ? 'flagged' : '',
          done ? 'faded' : '',
          watched ? 'hl-watch' : '',
          recentGifter ? 'hl-gifter' : '',
        ]
          .filter(Boolean)
          .join(' ');

        return (
          <div key={item.id} className={classes}>
            <FeedTime at={item.createdAt} />
            <div className="feed-line-main chat-line-main">
              <span className="chat-meta">
                <span className="chat-user">
                  {formatPersonLabel(
                    item.username,
                    item.userSignals?.nickname,
                    props.nameDisplayMode,
                    'anon',
                  )}
                </span>
                <ChatSignalTags signals={item.userSignals} />
              </span>
              <span className="chat-comment">
                <span className="chat-body">{item.comment}</span>
                {watched ? <span className="tag"> watch</span> : null}
                {recentGifter ? (
                  <span className="tag tag-gift"> gifted</span>
                ) : null}
                {item.flaggedKeyword ? (
                  <span className="tag"> {item.flaggedKeyword}</span>
                ) : null}
              </span>
            </div>
            {pending && item.queueItemId ? (
              <button
                type="button"
                className="primary tiny"
                disabled={props.busy}
                onClick={() => props.onDone(item.queueItemId!)}>
                Done
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function ChatSignalTags(props: Readonly<{ signals: ChatUserSignals | null }>) {
  const s = props.signals;
  if (!s) return null;
  const tags: { key: string; label: string; className: string }[] = [];
  if (s.isModerator)
    tags.push({ key: 'mod', label: 'mod', className: 'tag-mod' });
  if (s.isSubscriber)
    tags.push({ key: 'sub', label: 'sub', className: 'tag-sub' });
  if (s.isFollower)
    tags.push({ key: 'fol', label: 'follow', className: 'tag-follow' });
  if (s.isGiftGiver)
    tags.push({ key: 'gg', label: 'gifter', className: 'tag-gift' });
  if (s.fansClubName) {
    tags.push({
      key: 'fans',
      label:
        s.fansClubLevel != null
          ? `${s.fansClubName} Lv${s.fansClubLevel}`
          : s.fansClubName,
      className: 'tag-fans',
    });
  }
  if (s.payGradeName || s.payGradeLevel != null) {
    tags.push({
      key: 'pay',
      label:
        s.payGradeLevel != null
          ? `${s.payGradeName ?? 'tier'} ${s.payGradeLevel}`
          : (s.payGradeName ?? 'tier'),
      className: 'tag-pay',
    });
  }
  for (const label of s.badgeLabels.slice(0, 2)) {
    tags.push({ key: `b-${label}`, label, className: 'tag-badge' });
  }
  if (tags.length === 0) return null;
  return (
    <span className="signal-tags">
      {tags.map((t) => (
        <span key={t.key} className={`tag ${t.className}`}>
          {t.label}
        </span>
      ))}
    </span>
  );
}

function EventList(
  props: Readonly<{
    items: RoomLogItem[];
    nameDisplayMode: NameDisplayMode;
  }>,
) {
  if (props.items.length === 0) {
    return <p className="muted feed-empty">No matching events.</p>;
  }
  return (
    <div className="feed-inner">
      {props.items.map((item) => {
        const who =
          item.username || item.nickname
            ? formatPersonLabel(
                item.username,
                item.nickname,
                props.nameDisplayMode,
                'someone',
              )
            : null;
        // Legacy events baked the handle into summary; prefer verb + label when we have identity.
        const looksLegacy =
          Boolean(who) &&
          (item.summary.startsWith('@') || item.summary.startsWith(who!));
        const text =
          who && !looksLegacy ? `${who} ${item.summary}` : item.summary;
        return (
          <div key={item.id} className="feed-line">
            <FeedTime at={item.createdAt} />
            <div className="feed-line-main">
              <span className="event-type">{item.type}</span> {text}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function giftIsToGuest(
  targetUsername: string | null,
  hostUsername: string | null,
): boolean {
  if (targetUsername == null || hostUsername == null) return false;
  return targetUsername.toLowerCase() !== hostUsername.toLowerCase();
}

function GiftBulkBar(
  props: Readonly<{
    pendingIds: string[];
    showUndoAll: boolean;
    busy: boolean;
    onDoneAll: (giftIds: string[]) => void;
    onUndoAll: () => void;
  }>,
) {
  const showDoneAll = props.pendingIds.length > 0;
  if (!props.showUndoAll && !showDoneAll) return null;
  return (
    <div className="gift-done-all">
      {props.showUndoAll ? (
        <button
          type="button"
          className="tiny"
          disabled={props.busy}
          onClick={props.onUndoAll}>
          Undo all
        </button>
      ) : null}
      {showDoneAll ? (
        <button
          type="button"
          className="primary tiny"
          disabled={props.busy}
          onClick={() => props.onDoneAll(props.pendingIds)}>
          Mark all done
        </button>
      ) : null}
    </div>
  );
}

function GiftLine(
  props: Readonly<{
    item: GiftLogItem;
    important: boolean;
    hostUsername: string | null;
    nameDisplayMode: NameDisplayMode;
    busy: boolean;
    onDone: (giftId: string) => void;
    onUndo: (giftId: string) => void;
  }>,
) {
  const { item } = props;
  const pending = item.alertStatus !== 'done';
  const done = item.alertStatus === 'done';
  const toGuest = giftIsToGuest(item.targetUsername, props.hostUsername);
  const targetLabel = formatGiftTarget(
    item.targetUsername,
    item.targetNickname,
    props.nameDisplayMode,
  );
  const spend =
    item.diamondValue == null
      ? null
      : giftDiamondSpend(item.diamondValue, item.giftCount);
  const className = [
    'feed-line gift-line',
    item.matchedRule && pending ? 'alert' : '',
    props.important ? 'hl-enabled' : '',
    done ? 'faded' : '',
    toGuest ? 'gift-to-guest' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={className}>
      <FeedTime at={item.createdAt} />
      <div className="feed-line-main">
        <span className="chat-user">
          {formatPersonLabel(
            item.senderUsername,
            item.senderNickname,
            props.nameDisplayMode,
            'someone',
          )}
        </span>
        <span className="chat-body">
          sent{' '}
          <span
            className={props.important ? 'gift-name important' : 'gift-name'}>
            {item.giftName ?? 'gift'}
          </span>
          {spend == null ? (
            <> ×{item.giftCount}</>
          ) : (
            <span className="gift-spend"> {spend}◆</span>
          )}
          {targetLabel ? (
            <>
              {' '}
              to{' '}
              <span className={toGuest ? 'gift-target guest' : 'gift-target'}>
                {targetLabel}
              </span>
            </>
          ) : null}
          {toGuest ? <span className="tag tag-guest"> guest</span> : null}
          {item.matchedRule ? (
            <span className="tag"> {item.matchedRule}</span>
          ) : null}
        </span>
      </div>
      {pending ? (
        <button
          type="button"
          className="primary tiny"
          disabled={props.busy}
          onClick={() => props.onDone(item.id)}>
          Done
        </button>
      ) : (
        <button
          type="button"
          className="tiny"
          disabled={props.busy}
          onClick={() => props.onUndo(item.id)}>
          Undo
        </button>
      )}
    </div>
  );
}

function GiftList(
  props: Readonly<{
    items: GiftLogItem[];
    empty?: string;
    importantTypes: Set<string>;
    hostUsername: string | null;
    nameDisplayMode: NameDisplayMode;
    busy: boolean;
    bulkUndoIds: string[];
    onDone: (giftId: string) => void;
    onUndo: (giftId: string) => void;
    onDoneAll: (giftIds: string[]) => void;
    onUndoAll: () => void;
  }>,
) {
  const pendingIds = props.items
    .filter((item) => item.alertStatus !== 'done')
    .map((item) => item.id);
  const showUndoAll = props.bulkUndoIds.length > 0;
  const empty = props.empty ?? 'No gifts yet.';

  if (props.items.length === 0 && !showUndoAll) {
    return <p className="muted feed-empty">{empty}</p>;
  }
  return (
    <div className="feed-inner gifts">
      <GiftBulkBar
        pendingIds={pendingIds}
        showUndoAll={showUndoAll}
        busy={props.busy}
        onDoneAll={props.onDoneAll}
        onUndoAll={props.onUndoAll}
      />
      {props.items.length === 0 ? (
        <p className="muted feed-empty">{empty}</p>
      ) : (
        props.items.map((item) => (
          <GiftLine
            key={item.id}
            item={item}
            important={Boolean(
              item.giftName &&
              props.importantTypes.has(item.giftName.toLowerCase()),
            )}
            hostUsername={props.hostUsername}
            nameDisplayMode={props.nameDisplayMode}
            busy={props.busy}
            onDone={props.onDone}
            onUndo={props.onUndo}
          />
        ))
      )}
    </div>
  );
}

function formatResetIn(resetAt: string, now: number): string {
  const ms = new Date(resetAt).getTime() - now;
  if (ms <= 0) return 'soon (midnight UTC)';
  const totalMin = Math.max(0, Math.floor(ms / 60_000));
  const hours = Math.floor(totalMin / 60);
  const minutes = totalMin % 60;
  if (hours <= 0) return `${minutes}m (midnight UTC)`;
  return `${hours}h ${minutes}m (midnight UTC)`;
}

function formatCount(n: number): string {
  if (n >= 1_000_000) {
    const value = n / 1_000_000;
    return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)}M`;
  }
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return n.toLocaleString();
}

function metricPercent(used: number, limit: number): number {
  if (limit <= 0) return 0;
  return used / limit;
}

function worstMetric(quota: QuotaSnapshot) {
  return quota.metrics.reduce<(typeof quota.metrics)[number] | undefined>(
    (worst, metric) => {
      if (!worst) return metric;
      const pct = metricPercent(metric.used, metric.limit);
      const worstPct = metricPercent(worst.used, worst.limit);
      return pct > worstPct ? metric : worst;
    },
    undefined,
  );
}

function QuotaBanner(
  props: Readonly<{ quota: QuotaSnapshot | null; now: number }>,
) {
  if (!props.quota || props.quota.metrics.length === 0) return null;
  const worst = worstMetric(props.quota);
  if (!worst) return null;
  const pct = metricPercent(worst.used, worst.limit);
  if (pct < 0.5) return null;
  const exceeded = pct >= 1;
  return (
    <div className={`banner ${exceeded ? 'error' : 'warn'}`}>
      {exceeded
        ? `${worst.label} hit the daily free-tier limit (${formatCount(worst.used)} / ${formatCount(worst.limit)}). Further operations will fail until the limit resets in ${formatResetIn(props.quota.resetAt, props.now)}.`
        : `${worst.label} are at ${Math.round(pct * 100)}% of today's free-tier limit (${formatCount(worst.used)} / ${formatCount(worst.limit)}). Resets in ${formatResetIn(props.quota.resetAt, props.now)}.`}
    </div>
  );
}

function quotaBarClass(pct: number, exceeded: boolean): string {
  if (exceeded) return 'quota-bar-fill exceeded';
  if (pct >= 0.8) return 'quota-bar-fill high';
  if (pct >= 0.5) return 'quota-bar-fill warn';
  return 'quota-bar-fill';
}

function QuotaMeter(
  props: Readonly<{ quota: QuotaSnapshot; now: number }>,
) {
  return (
    <div className="field quota-card">
      <span>Cloudflare free-tier usage</span>
      <p className="muted note">
        UTC day {props.quota.date}. Resets in{' '}
        {formatResetIn(props.quota.resetAt, props.now)}.
        {props.quota.source === 'cloudflare'
          ? ' Billed totals from Cloudflare Analytics.'
          : ' Counted by this app; set an Analytics API token for billed totals.'}
      </p>
      <ul className="quota-list">
        {props.quota.metrics.map((metric) => {
          const pct = Math.min(1, metricPercent(metric.used, metric.limit));
          const exceeded = metric.used >= metric.limit;
          return (
            <li key={metric.key}>
              <div className="quota-row">
                <span>{metric.label}</span>
                <span className={exceeded ? 'quota-exceeded' : undefined}>
                  {formatCount(metric.used)} / {formatCount(metric.limit)}{' '}
                  ({Math.round(metricPercent(metric.used, metric.limit) * 100)}%)
                </span>
              </div>
              <div className="quota-bar" aria-hidden="true">
                <div
                  className={quotaBarClass(pct, exceeded)}
                  style={{ width: `${Math.min(100, pct * 100)}%` }}
                />
              </div>
            </li>
          );
        })}
      </ul>
      {props.quota.objects.length > 0 ? (
        <p className="muted note">
          Top objects:{' '}
          {props.quota.objects
            .slice(0, 4)
            .map(
              (object) =>
                `${object.name} ${formatCount(object.rowsRead)} reads`,
            )
            .join(' · ')}
        </p>
      ) : null}
    </div>
  );
}

function SettingsPanel(
  props: Readonly<{
    passcode: string;
    passcodeRequired: boolean;
    pushStatus: string;
    busy: boolean;
    quota: QuotaSnapshot | null;
    now: number;
    onPasscodeChange: (v: string) => void;
    onPasscodeBlur: () => void;
    onLock: () => void;
    onEnablePush: () => void;
    onTestPush: () => void;
  }>,
) {
  return (
    <section className="panel">
      <h1>Settings</h1>
      <p className="muted note">
        Alert defaults and name display are under Streams (Global defaults at
        the top; each stream can override).
      </p>
      {props.quota ? <QuotaMeter quota={props.quota} now={props.now} /> : null}
      {props.passcodeRequired ? (
        <div className="field">
          <span>Session</span>
          <button type="button" onClick={props.onLock}>
            Lock / sign out
          </button>
        </div>
      ) : (
        <label className="field">
          <span>Mod passcode (optional)</span>
          <input
            type="password"
            value={props.passcode}
            onChange={(e) => props.onPasscodeChange(e.target.value)}
            onBlur={props.onPasscodeBlur}
            placeholder="shared passcode"
          />
        </label>
      )}
      <div className="field">
        <span>Push notifications (Android Chrome)</span>
        <p className="muted note">
          The browser will also ask when you check in, so alerts work with the
          phone locked.
        </p>
        <div className="row">
          <button type="button" onClick={props.onEnablePush}>
            Enable push
          </button>
          <button
            type="button"
            disabled={props.busy}
            onClick={props.onTestPush}>
            Send test
          </button>
        </div>
        {props.pushStatus ? <p className="muted">{props.pushStatus}</p> : null}
      </div>
    </section>
  );
}

function isUnauthorized(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('401:');
}

async function ensureWebPush(
  vapidPublicKey: string | null,
  quiet = false,
): Promise<string> {
  if (!vapidPublicKey) {
    return quiet ? '' : 'VAPID public key not configured on the Worker.';
  }
  if (
    !('Notification' in window) ||
    !('serviceWorker' in navigator) ||
    !('PushManager' in window)
  ) {
    return quiet ? '' : 'Push not supported in this browser.';
  }

  let permission = Notification.permission;
  if (permission === 'denied') {
    return quiet ? '' : 'Notifications are blocked for this site.';
  }

  const asked = permission === 'default';
  if (asked) {
    permission = await Notification.requestPermission();
  }
  if (permission !== 'granted') {
    return quiet ? '' : `Permission: ${permission}`;
  }

  const reg = await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(
        vapidPublicKey,
      ) as BufferSource,
    }));
  await subscribePush(sub.toJSON());
  if (quiet && !asked) return '';
  return 'Subscribed to push.';
}
