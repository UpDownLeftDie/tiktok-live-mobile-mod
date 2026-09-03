import {
  formatGiftTarget,
  dedupeGiftCatalogByName,
  giftDiamondSpend,
  type ChatHighlightConfig,
  type ChatLogItem,
  type ChatUserSignals,
  type ConnectionStatus,
  type GiftAlertRule,
  type GiftCatalogItem,
  type GiftLogItem,
  type LiveFeed,
  type RoomEventType,
  type RoomLogItem,
} from '@tiktok-mod/shared';
import {
  useCallback,
  useEffect,
  useMemo,
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
  getConfig,
  getGiftCatalog,
  getLiveFeed,
  getPasscode,
  listStreams,
  markDone,
  markGiftDone,
  markGiftPending,
  markGiftsDone,
  markGiftsPending,
  putConfig,
  removeStream,
  setPasscode,
  statusLabel,
  subscribePush,
  testPush,
  urlBase64ToUint8Array,
} from './api';

type StreamRow = {
  streamId: string;
  addedAt: number;
  isCheckedIn: boolean;
};

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

type ChatFilterKind =
  | 'flagged'
  | 'watch'
  | 'gifter'
  | 'mod'
  | 'sub'
  | 'follow';

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
  enabledGiftNames: [],
  chat: [],
  events: [],
  gifts: [],
};

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

  const selectedStream = useMemo(
    () => streams.find((s) => s.streamId === selected) ?? null,
    [streams, selected],
  );

  const handleUnauthorized = useCallback(() => {
    setPasscode('');
    setStreams([]);
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

  const refreshLive = useCallback(async () => {
    if (!selected) {
      setFeed(EMPTY_FEED);
      return;
    }
    try {
      setFeed(await getLiveFeed(selected));
    } catch (err) {
      if (isUnauthorized(err)) {
        handleUnauthorized();
        return;
      }
      throw err;
    }
  }, [selected, handleUnauthorized]);

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

  useEffect(() => {
    void refreshLive().catch(() => undefined);
    const id = window.setInterval(() => {
      void refreshLive().catch(() => undefined);
      void refreshStreams().catch(() => undefined);
    }, 2500);
    return () => window.clearInterval(id);
  }, [refreshLive, refreshStreams]);

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
    if (!props.vapidPublicKey) {
      setPushStatus('VAPID public key not configured on the Worker.');
      return;
    }
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      setPushStatus('Push not supported in this browser.');
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      setPushStatus(`Permission: ${permission}`);
      return;
    }
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(
        props.vapidPublicKey,
      ) as BufferSource,
    });
    await subscribePush(sub.toJSON());
    setPushStatus('Subscribed to push.');
  }

  const status: ConnectionStatus = selectedStream?.isCheckedIn
    ? feed.status
    : 'idle';

  return (
    <div className="app">
      <header className="header">
        <div>
          <p className="brand">Live Mod</p>
          <p className="sub">
            {selected ? `@${selected}` : 'TikTok LIVE alerts — phone-first'}
          </p>
        </div>
        <StatusChip
          status={status}
          checkedIn={Boolean(selectedStream?.isCheckedIn)}
        />
      </header>

      {error ? <div className="banner error">{error}</div> : null}

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
            feed={feed}
            busy={busy}
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
    feed: LiveFeed;
    busy: boolean;
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

  const enabledGiftNames = props.feed.enabledGiftNames ?? [];
  const enabledGiftKey = enabledGiftNames.map((n) => n.toLowerCase()).join('\0');

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
  const importantTypes = new Set(
    enabledGiftNames.map((n) => n.toLowerCase()),
  );

  return (
    <section className="panel live-panel">
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
                    className={
                      chatFilters.has(f.type) ? 'pill active' : 'pill'
                    }
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
            <EventList items={filteredEvents} />
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
    if (giftDiamondSpend(g.diamondValue, g.giftCount) < highlights.recentGifterMinDiamonds)
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
    return (
      <p className="muted feed-empty">{props.empty ?? 'No chat yet.'}</p>
    );
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
            <div className="feed-line-main">
              <span className="chat-user">
                {item.userSignals?.nickname
                  ? `${item.userSignals.nickname} `
                  : null}
                @{item.username ?? 'anon'}
              </span>
              <ChatSignalTags signals={item.userSignals} />
              <span className="chat-body">{item.comment}</span>
              {watched ? <span className="tag"> watch</span> : null}
              {recentGifter ? (
                <span className="tag tag-gift"> gifted</span>
              ) : null}
              {item.flaggedKeyword ? (
                <span className="tag"> {item.flaggedKeyword}</span>
              ) : null}
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

function EventList(props: Readonly<{ items: RoomLogItem[] }>) {
  if (props.items.length === 0) {
    return <p className="muted feed-empty">No matching events.</p>;
  }
  return (
    <div className="feed-inner">
      {props.items.map((item) => (
        <div key={item.id} className="feed-line">
          <FeedTime at={item.createdAt} />
          <div className="feed-line-main">
            <span className="event-type">{item.type}</span> {item.summary}
          </div>
        </div>
      ))}
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
        <span className="chat-user">@{item.senderUsername ?? 'someone'}</span>
        <span className="chat-body">
          sent{' '}
          <span className={props.important ? 'gift-name important' : 'gift-name'}>
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
            busy={props.busy}
            onDone={props.onDone}
            onUndo={props.onUndo}
          />
        ))
      )}
    </div>
  );
}

function StreamsPanel(
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
    onRemove: (id: string) => void;
    onUnauthorized: () => void;
    onStreamSettingsSaved: (streamId: string) => void;
    withBusy: (fn: () => Promise<void>) => Promise<void>;
  }>,
) {
  const [settingsStreamId, setSettingsStreamId] = useState<string | null>(null);

  return (
    <section className="panel">
      <h1>Streams</h1>
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
              <button
                type="button"
                className={
                  props.selected === s.streamId
                    ? 'stream-btn selected'
                    : 'stream-btn'
                }
                onClick={() => props.onSelect(s.streamId)}>
                <span>@{s.streamId}</span>
                <span className="muted">
                  {s.isCheckedIn ? 'checked in' : 'out'}
                </span>
              </button>
              <div className="row tight">
                {s.isCheckedIn ? (
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

function SwitchField(
  props: Readonly<{
    label: string;
    checked: boolean;
    onChange: (checked: boolean) => void;
  }>,
) {
  return (
    <label className="switch-field">
      <span>{props.label}</span>
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

type StreamSettingsValues = {
  keywordsText: string;
  minDiamonds: string;
  notifyDiamonds: boolean;
  catalogGifts: GiftCatalogItem[];
  enabledGiftKeys: string[];
  notifyGifts: boolean;
  highlightUsersText: string;
  highlightRecentGifters: boolean;
  recentGifterMinDiamonds: string;
  recentGifterWindowSeconds: string;
};

async function fetchStreamSettingsValues(
  streamId: string,
): Promise<StreamSettingsValues> {
  const cfg = await getConfig(streamId);
  const diamondRule = cfg.giftAlertRules.find(
    (r) => typeof r.minDiamondValue === 'number' && !r.giftName,
  );
  const namedRules = cfg.giftAlertRules.filter((r) =>
    Boolean(r.giftName?.trim()),
  );
  const enabledGiftKeys = namedRules
    .map((r) => r.giftName?.trim().toLowerCase())
    .filter((n): n is string => Boolean(n));
  let fromCatalog: GiftCatalogItem[] = [];
  try {
    fromCatalog = (await getGiftCatalog()).gifts ?? [];
  } catch {
    fromCatalog = [];
  }
  const catalogKeys = new Set(fromCatalog.map((g) => g.name.toLowerCase()));
  const extras: GiftCatalogItem[] = namedRules
    .map((r) => r.giftName?.trim())
    .filter((n): n is string => Boolean(n))
    .filter((n) => !catalogKeys.has(n.toLowerCase()))
    .map((name) => ({ id: null, name, diamondValue: null }));
  const h = cfg.chatHighlights ?? DEFAULT_CHAT_HIGHLIGHTS;
  return {
    keywordsText: cfg.chatKeywordFlags.join('\n'),
    minDiamonds: String(diamondRule?.minDiamondValue ?? 100),
    notifyDiamonds: diamondRule?.notify !== false,
    catalogGifts: dedupeGiftCatalogByName([...extras, ...fromCatalog]),
    enabledGiftKeys,
    notifyGifts:
      namedRules.length === 0 || namedRules.some((r) => r.notify !== false),
    highlightUsersText: h.highlightUsernames.join('\n'),
    highlightRecentGifters: h.highlightRecentGifters,
    recentGifterMinDiamonds: String(h.recentGifterMinDiamonds),
    recentGifterWindowSeconds: String(h.recentGifterWindowSeconds),
  };
}

function splitSettingLines(text: string): string[] {
  return text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildStreamConfigUpdate(input: {
  catalogGifts: GiftCatalogItem[];
  enabledGiftKeys: Set<string>;
  minDiamonds: string;
  notifyDiamonds: boolean;
  notifyGifts: boolean;
  keywordsText: string;
  highlightUsersText: string;
  highlightRecentGifters: boolean;
  recentGifterMinDiamonds: string;
  recentGifterWindowSeconds: string;
}): {
  giftAlertRules: GiftAlertRule[];
  chatKeywordFlags: string[];
  chatHighlights: ChatHighlightConfig;
} {
  const names = input.catalogGifts
    .filter((g) => input.enabledGiftKeys.has(g.name.toLowerCase()))
    .map((g) => g.name);
  const diamondValue = Number(input.minDiamonds) || 100;
  return {
    giftAlertRules: [
      {
        minDiamondValue: diamondValue,
        label: `Gift ≥ ${diamondValue} diamonds`,
        notify: input.notifyDiamonds,
      },
      ...names.map((giftName) => ({
        giftName,
        label: giftName,
        notify: input.notifyGifts,
      })),
    ],
    chatKeywordFlags: splitSettingLines(input.keywordsText),
    chatHighlights: {
      highlightUsernames: splitSettingLines(input.highlightUsersText).map(
        (s) => s.replace(/^@/, ''),
      ),
      highlightRecentGifters: input.highlightRecentGifters,
      recentGifterMinDiamonds: Number(input.recentGifterMinDiamonds) || 1,
      recentGifterWindowSeconds: Number(input.recentGifterWindowSeconds) || 120,
    },
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

function StreamSettingsForm(
  props: Readonly<{
    busy: boolean;
    streamId: string;
    withBusy: (fn: () => Promise<void>) => Promise<void>;
    onSaved: () => void;
    keywordsText: string;
    minDiamonds: string;
    notifyDiamonds: boolean;
    catalogGifts: GiftCatalogItem[];
    catalogQuery: string;
    enabledGiftKeys: Set<string>;
    notifyGifts: boolean;
    highlightUsersText: string;
    highlightRecentGifters: boolean;
    recentGifterMinDiamonds: string;
    recentGifterWindowSeconds: string;
    setKeywordsText: (v: string) => void;
    setMinDiamonds: (v: string) => void;
    setNotifyDiamonds: (v: boolean) => void;
    setCatalogQuery: (v: string) => void;
    setEnabledGiftKeys: (updater: (prev: Set<string>) => Set<string>) => void;
    setNotifyGifts: (v: boolean) => void;
    setHighlightUsersText: (v: string) => void;
    setHighlightRecentGifters: (v: boolean) => void;
    setRecentGifterMinDiamonds: (v: string) => void;
    setRecentGifterWindowSeconds: (v: string) => void;
  }>,
) {
  function toggleGiftKey(key: string) {
    props.setEnabledGiftKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <>
      <div className="settings-block">
        <SwitchField
          label="Diamond threshold alerts"
          checked={props.notifyDiamonds}
          onChange={props.setNotifyDiamonds}
        />
        {props.notifyDiamonds ? (
          <label className="field nested">
            <span>Min diamonds spent</span>
            <input
              type="number"
              min={1}
              value={props.minDiamonds}
              onChange={(e) => props.setMinDiamonds(e.target.value)}
            />
          </label>
        ) : null}
      </div>
      <div className="settings-block">
        <SwitchField
          label="Gift type alerts"
          checked={props.notifyGifts}
          onChange={props.setNotifyGifts}
        />
        {props.notifyGifts ? (
          <div className="field nested">
            <span>Important gifts</span>
            <GiftPicker
              catalogGifts={props.catalogGifts}
              catalogQuery={props.catalogQuery}
              enabledGiftKeys={props.enabledGiftKeys}
              onQueryChange={props.setCatalogQuery}
              onToggleKey={toggleGiftKey}
            />
          </div>
        ) : null}
      </div>
      <label className="field">
        <span>Flagged chat keywords (one per line)</span>
        <textarea
          rows={3}
          value={props.keywordsText}
          onChange={(e) => props.setKeywordsText(e.target.value)}
          placeholder={'spam\nscam'}
        />
      </label>
      <label className="field">
        <span>Always highlight usernames (one per line)</span>
        <textarea
          rows={3}
          value={props.highlightUsersText}
          onChange={(e) => props.setHighlightUsersText(e.target.value)}
          placeholder={'vip_user\ncohost'}
        />
      </label>
      <label className="check-field">
        <input
          type="checkbox"
          checked={props.highlightRecentGifters}
          onChange={(e) => props.setHighlightRecentGifters(e.target.checked)}
        />
        <span>Highlight chat from recent gifters</span>
      </label>
      <div className="row">
        <label className="field grow">
          <span>Gifter min diamonds spent</span>
          <input
            type="number"
            min={1}
            value={props.recentGifterMinDiamonds}
            onChange={(e) => props.setRecentGifterMinDiamonds(e.target.value)}
          />
        </label>
        <label className="field grow">
          <span>Window (seconds)</span>
          <input
            type="number"
            min={10}
            value={props.recentGifterWindowSeconds}
            onChange={(e) =>
              props.setRecentGifterWindowSeconds(e.target.value)
            }
          />
        </label>
      </div>
      <button
        type="button"
        className="primary"
        disabled={props.busy}
        onClick={() =>
          void props.withBusy(async () => {
            await putConfig(
              props.streamId,
              buildStreamConfigUpdate({
                catalogGifts: props.catalogGifts,
                enabledGiftKeys: props.enabledGiftKeys,
                minDiamonds: props.minDiamonds,
                notifyDiamonds: props.notifyDiamonds,
                notifyGifts: props.notifyGifts,
                keywordsText: props.keywordsText,
                highlightUsersText: props.highlightUsersText,
                highlightRecentGifters: props.highlightRecentGifters,
                recentGifterMinDiamonds: props.recentGifterMinDiamonds,
                recentGifterWindowSeconds: props.recentGifterWindowSeconds,
              }),
            );
            props.onSaved();
          })
        }>
        Save stream settings
      </button>
    </>
  );
}

function StreamSettingsEditor(
  props: Readonly<{
    streamId: string;
    busy: boolean;
    withBusy: (fn: () => Promise<void>) => Promise<void>;
    onUnauthorized: () => void;
    onSaved: () => void;
  }>,
) {
  const { streamId, onUnauthorized } = props;
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [keywordsText, setKeywordsText] = useState('');
  const [minDiamonds, setMinDiamonds] = useState('100');
  const [notifyDiamonds, setNotifyDiamonds] = useState(true);
  const [catalogGifts, setCatalogGifts] = useState<GiftCatalogItem[]>([]);
  const [catalogQuery, setCatalogQuery] = useState('');
  const [enabledGiftKeys, setEnabledGiftKeys] = useState<Set<string>>(
    () => new Set(),
  );
  const [notifyGifts, setNotifyGifts] = useState(true);
  const [highlightUsersText, setHighlightUsersText] = useState('');
  const [highlightRecentGifters, setHighlightRecentGifters] = useState(true);
  const [recentGifterMinDiamonds, setRecentGifterMinDiamonds] = useState('1');
  const [recentGifterWindowSeconds, setRecentGifterWindowSeconds] =
    useState('120');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    void fetchStreamSettingsValues(streamId).then(
      (values) => {
        if (cancelled) return;
        setKeywordsText(values.keywordsText);
        setMinDiamonds(values.minDiamonds);
        setNotifyDiamonds(values.notifyDiamonds);
        setCatalogGifts(values.catalogGifts);
        setEnabledGiftKeys(new Set(values.enabledGiftKeys));
        setNotifyGifts(values.notifyGifts);
        setHighlightUsersText(values.highlightUsersText);
        setHighlightRecentGifters(values.highlightRecentGifters);
        setRecentGifterMinDiamonds(values.recentGifterMinDiamonds);
        setRecentGifterWindowSeconds(values.recentGifterWindowSeconds);
      },
      (err: unknown) => {
        if (cancelled) return;
        if (isUnauthorized(err)) {
          onUnauthorized();
          return;
        }
        setLoadError(err instanceof Error ? err.message : String(err));
      },
    ).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [streamId, onUnauthorized]);

  const ready = !loading && !loadError;

  return (
    <div className="stream-settings">
      <h3 className="settings-section">Alerts &amp; highlights</h3>
      {loading ? <p className="muted">Loading settings…</p> : null}
      {loadError ? <p className="banner error">{loadError}</p> : null}
      {ready ? (
        <StreamSettingsForm
          busy={props.busy}
          streamId={props.streamId}
          withBusy={props.withBusy}
          onSaved={props.onSaved}
          keywordsText={keywordsText}
          minDiamonds={minDiamonds}
          notifyDiamonds={notifyDiamonds}
          catalogGifts={catalogGifts}
          catalogQuery={catalogQuery}
          enabledGiftKeys={enabledGiftKeys}
          notifyGifts={notifyGifts}
          highlightUsersText={highlightUsersText}
          highlightRecentGifters={highlightRecentGifters}
          recentGifterMinDiamonds={recentGifterMinDiamonds}
          recentGifterWindowSeconds={recentGifterWindowSeconds}
          setKeywordsText={setKeywordsText}
          setMinDiamonds={setMinDiamonds}
          setNotifyDiamonds={setNotifyDiamonds}
          setCatalogQuery={setCatalogQuery}
          setEnabledGiftKeys={setEnabledGiftKeys}
          setNotifyGifts={setNotifyGifts}
          setHighlightUsersText={setHighlightUsersText}
          setHighlightRecentGifters={setHighlightRecentGifters}
          setRecentGifterMinDiamonds={setRecentGifterMinDiamonds}
          setRecentGifterWindowSeconds={setRecentGifterWindowSeconds}
        />
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
        Per-stream alerts and chat highlights are on each stream card under
        Streams.
      </p>
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
