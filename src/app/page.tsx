"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { BluetoothCommunication } from "@yesprasoon/capacitor-bluetooth-communication";

type AppState = "idle" | "scanning" | "device_list" | "connecting" | "connected" | "error";

interface BtDevice {
  name: string;
  address: string;
}

interface LogEntry {
  id: number;
  dir: "rx" | "tx" | "sys";
  text: string;
}

interface ReceivedFile {
  id: number;
  name: string;
  originalSize: number;
  url: string;
  mime: string;
}

interface SendProgress {
  filename: string;
  sent: number;   // chunks sent so far
  total: number;  // total chunks
}

// ── Transfer constants ─────────────────────────────────────────────────
/** Raw binary bytes per chunk. Base64-encoded each chunk = ceil(512*4/3)=684 chars,
 *  well within RFCOMM MTU (~990 bytes). */
const CHUNK_SIZE = 512;
/** Delay between chunks (ms) – lets the remote device process each packet. */
const INTER_CHUNK_DELAY = 30;

const MIME_MAP: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml",
  pdf: "application/pdf", txt: "text/plain", csv: "text/csv",
  json: "application/json", zip: "application/zip",
};

let logCounter = 0;
let fileIdCounter = 0;

// ── Pure helpers (no hooks) ────────────────────────────────────────────
function mimeOf(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return MIME_MAP[ext] ?? "application/octet-stream";
}

function bufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

// Parse a battery percentage out of any SPP/RFCOMM data string.
function parseBattery(raw: string): number | null {
  const s = raw.toLowerCase().trim();
  const patterns = [
    /bat(?:tery)?\s*[=:]\s*(\d{1,3})/,
    /\+cbc:\d+,(\d{1,3})/,
    /(\d{1,3})\s*%/,
    /^(\d{1,3})$/,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) {
      const v = parseInt(m[1], 10);
      if (v >= 0 && v <= 100) return v;
    }
  }
  return null;
}

export default function Home() {
  const [appState, setAppState] = useState<AppState>("idle");
  const [statusMsg, setStatusMsg] = useState("Tap 'Scan' to find paired devices.");
  const [devices, setDevices] = useState<BtDevice[]>([]);
  const [connectedDevice, setConnectedDevice] = useState<BtDevice | null>(null);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [inputText, setInputText] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [batteryLevel, setBatteryLevel] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<"terminal" | "files">("terminal");
  const [receivedFiles, setReceivedFiles] = useState<ReceivedFile[]>([]);
  const [sendProgress, setSendProgress] = useState<SendProgress | null>(null);
  const [isSending, setIsSending] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);
  const listenerRef = useRef<{ remove: () => void } | null>(null);
  const rxBufferRef = useRef<string>("");
  const abortSendRef = useRef<boolean>(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const receivedFilesRef = useRef<ReceivedFile[]>([]);

  const addLog = useCallback((dir: LogEntry["dir"], text: string) => {
    setLog((prev) => [...prev, { id: logCounter++, dir, text }]);
  }, []);

  // Auto-scroll log to bottom
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [log]);

  // Remove listener on unmount
  useEffect(() => {
    return () => {
      listenerRef.current?.remove();
    };
  }, []);

  // ── Receive buffer parser ──────────────────────────────────────────
  // Scans rxBufferRef for complete FILE_START…FILE_END frames.
  // Must only use refs & stable setters (called from inside listener closure).
  const processBuffer = useCallback(() => {
    let buf = rxBufferRef.current;
    const START_TAG = "FILE_START:";
    const END_TAG   = "FILE_END:";

    while (buf.includes(START_TAG)) {
      const startIdx = buf.indexOf(START_TAG);
      const headerEnd = buf.indexOf("\n", startIdx);
      if (headerEnd === -1) break;

      const header = buf.substring(startIdx + START_TAG.length, headerEnd);
      const colonIdx = header.lastIndexOf(":");
      const rawName = header.substring(0, colonIdx);
      const originalSize = parseInt(header.substring(colonIdx + 1), 10);

      const endSearch = END_TAG + rawName + "\n";
      const endIdx = buf.indexOf(endSearch, headerEnd);
      if (endIdx === -1) break; // frame not yet complete

      const body = buf.substring(headerEnd + 1, endIdx);
      const chunkLines = body.split("\n").filter((l) => l.startsWith("CHUNK:"));
      const b64Parts = chunkLines.map((l) => {
        const third = l.indexOf(":", l.indexOf(":") + 1);
        return l.substring(third + 1);
      });
      const fullB64 = b64Parts.join("").replace(/\s/g, "");

      try {
        const bytes = base64ToUint8Array(fullB64);
        const mime  = mimeOf(rawName);
        const blob  = new Blob([bytes.buffer as ArrayBuffer], { type: mime });
        const url   = URL.createObjectURL(blob);
        const newFile: ReceivedFile = { id: fileIdCounter++, name: rawName, originalSize, url, mime };
        receivedFilesRef.current = [...receivedFilesRef.current, newFile];
        setReceivedFiles([...receivedFilesRef.current]);
        addLog("sys", `✓ File received: ${rawName} (${formatBytes(originalSize)})`);
      } catch {
        addLog("sys", `✗ Failed to decode: ${rawName}`);
      }

      buf = buf.substring(endIdx + endSearch.length);
    }
    rxBufferRef.current = buf;
  }, [addLog]);

  // ── Scan for paired devices ────────────────────────────────────────
  const handleScan = useCallback(async () => {
    setIsBusy(true);
    setAppState("scanning");
    setStatusMsg("Initializing Bluetooth...");
    try {
      await BluetoothCommunication.initialize();
      await BluetoothCommunication.enableBluetooth();

      setStatusMsg("Scanning for paired devices...");
      setAppState("scanning");

      const result = await BluetoothCommunication.scanDevices();
      const found = result.devices as BtDevice[];

      if (found.length === 0) {
        setStatusMsg("No paired devices found. Pair your device in Android Settings first.");
        setAppState("idle");
      } else {
        setDevices(found);
        setStatusMsg(`Found ${found.length} paired device(s). Select one to connect.`);
        setAppState("device_list");
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatusMsg(`Error: ${msg}`);
      setAppState("error");
    } finally {
      setIsBusy(false);
    }
  }, []);

  // ── Connect to a device ────────────────────────────────────────────
  const handleConnect = useCallback(
    async (device: BtDevice) => {
      setIsBusy(true);
      setAppState("connecting");
      setStatusMsg(`Connecting to ${device.name || device.address}...`);
      try {
        await BluetoothCommunication.connect({ address: device.address });

        // Subscribe to incoming data
        const handle = await BluetoothCommunication.addListener(
          "dataReceived",
          (event: { data: string }) => {
            addLog("rx", event.data);
            const parsed = parseBattery(event.data);
            if (parsed !== null) setBatteryLevel(parsed);
            // Accumulate in buffer and scan for complete file frames
            rxBufferRef.current += event.data;
            processBuffer();
          }
        );
        listenerRef.current = handle;

        setConnectedDevice(device);
        setLog([]);
        setBatteryLevel(null);
        rxBufferRef.current = "";
        receivedFilesRef.current = [];
        setReceivedFiles([]);
        setActiveTab("terminal");
        setAppState("connected");
        setStatusMsg(`Connected to ${device.name || device.address}`);
        addLog("sys", `Connected to ${device.name || device.address}`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        setStatusMsg(`Connection failed: ${msg}`);
        setAppState("device_list");
      } finally {
        setIsBusy(false);
      }
    },
    [addLog]
  );

  // ── Send data ──────────────────────────────────────────────────────
  const handleSend = useCallback(async () => {
    if (!inputText.trim()) return;
    const payload = inputText.trim();
    setInputText("");
    try {
      await BluetoothCommunication.sendData({ data: payload });
      addLog("tx", payload);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      addLog("sys", `Send failed: ${msg}`);
    }
  }, [inputText, addLog]);

  // ── Disconnect ─────────────────────────────────────────────────────
  const handleDisconnect = useCallback(async () => {
    setIsBusy(true);
    try {
      listenerRef.current?.remove();
      listenerRef.current = null;
      await BluetoothCommunication.disconnect();
      addLog("sys", "Disconnected.");
    } catch {
      // ignore
    }
    // Free blob URLs allocated for received files
    receivedFilesRef.current.forEach((f) => URL.revokeObjectURL(f.url));
    receivedFilesRef.current = [];
    rxBufferRef.current = "";
    abortSendRef.current = true;
    setReceivedFiles([]);
    setSendProgress(null);
    setIsSending(false);
    setConnectedDevice(null);
    setBatteryLevel(null);
    setAppState("idle");
    setDevices([]);
    setStatusMsg("Disconnected. Tap 'Scan' to connect again.");
    setIsBusy(false);
  }, [addLog]);

  // ── Request battery level from device ─────────────────────────────
  // Sends a standard AT command; many Classic BT devices (headsets, modules)
  // respond with e.g. "+CBC:0,85" or "battery:85".
  const handleRequestBattery = useCallback(async () => {
    try {
      await BluetoothCommunication.sendData({ data: "AT+CBC\r\n" });
      addLog("tx", "AT+CBC (battery query)");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      addLog("sys", `Battery request failed: ${msg}`);
    }
  }, [addLog]);

  // ── Send a file over RFCOMM (base64-chunked framing protocol) ─────
  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      e.target.value = ""; // reset so same file can be re-selected

      setIsSending(true);
      abortSendRef.current = false;

      try {
        const buffer  = await file.arrayBuffer();
        const fullB64 = bufferToBase64(buffer);

        // Each chunk = CHUNK_SIZE binary bytes → ceil(CHUNK_SIZE*4/3) base64 chars,
        // rounded up to nearest multiple of 4 (valid base64 boundary).
        const b64ChunkLen = Math.ceil((CHUNK_SIZE * 4) / 3 / 4) * 4;
        const chunks: string[] = [];
        for (let i = 0; i < fullB64.length; i += b64ChunkLen)
          chunks.push(fullB64.slice(i, i + b64ChunkLen));

        setSendProgress({ filename: file.name, sent: 0, total: chunks.length });
        addLog("tx", `Sending: ${file.name} (${formatBytes(file.size)}, ${chunks.length} chunks)`);

        await BluetoothCommunication.sendData({ data: `FILE_START:${file.name}:${file.size}\n` });
        await sleep(INTER_CHUNK_DELAY);

        for (let i = 0; i < chunks.length; i++) {
          if (abortSendRef.current) {
            await BluetoothCommunication.sendData({ data: `FILE_ABORT:${file.name}\n` });
            addLog("sys", "File send aborted.");
            break;
          }
          await BluetoothCommunication.sendData({ data: `CHUNK:${i}:${chunks[i]}\n` });
          setSendProgress({ filename: file.name, sent: i + 1, total: chunks.length });
          await sleep(INTER_CHUNK_DELAY);
        }

        if (!abortSendRef.current) {
          await BluetoothCommunication.sendData({ data: `FILE_END:${file.name}\n` });
          addLog("sys", `✓ File sent: ${file.name}`);
        }
      } catch (err: unknown) {
        addLog("sys", `File send error: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setSendProgress(null);
        setIsSending(false);
        abortSendRef.current = false;
      }
    },
    [addLog]
  );

  const triggerFilePick  = useCallback(() => fileInputRef.current?.click(), []);
  const handleAbortSend  = useCallback(() => { abortSendRef.current = true; }, []);

  // ── Key-down on input (Enter to send) ──────────────────────────────
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") handleSend();
    },
    [handleSend]
  );

  /* ─── Derived colours ───────────────────────────────────────────── */
  const stateColor: Record<AppState, string> = {
    idle: "text-slate-400", scanning: "text-blue-400",
    device_list: "text-amber-400", connecting: "text-amber-400",
    connected: "text-emerald-400", error: "text-red-400",
  };
  const batteryBarColor = batteryLevel === null ? "bg-slate-600"
    : batteryLevel > 50 ? "bg-emerald-400"
    : batteryLevel > 20 ? "bg-amber-400" : "bg-red-500";
  const batteryTextColor = batteryLevel === null ? "text-slate-500"
    : batteryLevel > 50 ? "text-emerald-400"
    : batteryLevel > 20 ? "text-amber-400" : "text-red-400";
  const logColor = (d: LogEntry["dir"]) =>
    d === "rx" ? "text-emerald-300" : d === "tx" ? "text-sky-300" : "text-slate-400";
  const logPrefix = (d: LogEntry["dir"]) =>
    d === "rx" ? "RX ← " : d === "tx" ? "TX → " : "   # ";

  /* ─── File type icon ────────────────────────────────────────────── */
  const fileIcon = (mime: string) => {
    if (mime.startsWith("image/")) return "🖼";
    if (mime === "application/pdf") return "📄";
    if (mime.startsWith("text/")) return "📝";
    if (mime === "application/zip") return "🗜";
    return "📦";
  };

  /* ─── Send progress pct ─────────────────────────────────────────── */
  const sendPct = sendProgress
    ? Math.round((sendProgress.sent / sendProgress.total) * 100)
    : 0;

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-slate-900 p-4">
      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        onChange={handleFileChange}
      />

      <div className="w-full max-w-md rounded-2xl bg-slate-800 p-6 shadow-2xl flex flex-col gap-5">

        {/* ── Header ───────────────────────────────────────────────── */}
        <div className="text-center">
          <h1 className="text-2xl font-bold text-white tracking-tight">
            BT Classic Terminal
          </h1>
          <p className="mt-1 text-xs text-slate-400">
            Bluetooth Classic (RFCOMM/SPP) · Android only
          </p>
        </div>

        {/* ── Status bar ───────────────────────────────────────────── */}
        <div className="rounded-lg bg-slate-700/60 px-4 py-2">
          <p className="text-xs font-semibold uppercase tracking-widest text-slate-500 mb-0.5">Status</p>
          <p className={`text-sm font-medium break-words ${stateColor[appState]}`}>{statusMsg}</p>
        </div>

        {/* ── Device list ──────────────────────────────────────────── */}
        {appState === "device_list" && (
          <div className="flex flex-col gap-2">
            <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">Paired Devices</p>
            {devices.map((d) => (
              <button
                key={d.address}
                onClick={() => handleConnect(d)}
                disabled={isBusy}
                className="flex items-center justify-between rounded-xl bg-slate-700 px-4 py-3 text-left hover:bg-slate-600 active:scale-[0.98] transition-all disabled:opacity-50"
              >
                <span className="text-sm font-semibold text-white">{d.name || "(unknown)"}</span>
                <span className="text-xs text-slate-400 font-mono">{d.address}</span>
              </button>
            ))}
          </div>
        )}

        {/* ── Connected UI ─────────────────────────────────────────── */}
        {appState === "connected" && (
          <>
            {/* ── Battery widget ─────────────────────────────────── */}
            <div className="rounded-xl bg-slate-700/50 px-4 py-3 flex items-center gap-4 border border-slate-600/50">
              <div className="w-12 h-6 rounded border-2 border-slate-500 relative flex items-center px-0.5 shrink-0">
                <div className="absolute -right-[5px] top-1/2 -translate-y-1/2 w-1.5 h-3 rounded-r border border-slate-500 bg-slate-700" />
                <div
                  className={`h-3.5 rounded-sm transition-all duration-500 ${batteryBarColor}`}
                  style={{ width: batteryLevel !== null ? `${batteryLevel}%` : "0%" }}
                />
              </div>
              <div className="flex-1">
                <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">Battery</p>
                <p className={`text-2xl font-black tabular-nums leading-none mt-0.5 ${batteryTextColor}`}>
                  {batteryLevel !== null ? `${batteryLevel}%` : "--"}
                </p>
              </div>
              <button
                onClick={handleRequestBattery}
                className="rounded-lg bg-slate-600 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:bg-slate-500 active:scale-95 transition-all"
              >
                Request
              </button>
            </div>

            {/* ── Tab bar ────────────────────────────────────────── */}
            <div className="flex rounded-xl bg-slate-900/60 p-1 gap-1">
              {(["terminal", "files"] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`flex-1 rounded-lg py-1.5 text-xs font-semibold transition-all capitalize
                    ${
                      activeTab === tab
                        ? "bg-slate-600 text-white"
                        : "text-slate-400 hover:text-slate-200"
                    }`}
                >
                  {tab}
                  {tab === "files" && receivedFiles.length > 0 && (
                    <span className="ml-1.5 rounded-full bg-blue-500 px-1.5 py-0.5 text-[10px] font-bold text-white">
                      {receivedFiles.length}
                    </span>
                  )}
                </button>
              ))}
            </div>

            {/* ── Terminal tab ───────────────────────────────────── */}
            {activeTab === "terminal" && (
              <div className="flex flex-col gap-3">
                <div className="h-48 overflow-y-auto rounded-xl bg-slate-900 px-3 py-2 font-mono text-xs space-y-0.5 border border-slate-700">
                  {log.length === 0 && <p className="text-slate-600 italic">No data yet…</p>}
                  {log.map((entry) => (
                    <p key={entry.id} className={logColor(entry.dir)}>
                      <span className="text-slate-600">{logPrefix(entry.dir)}</span>
                      {entry.text}
                    </p>
                  ))}
                  <div ref={logEndRef} />
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={inputText}
                    onChange={(e) => setInputText(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Type a message…"
                    className="flex-1 rounded-xl bg-slate-700 px-4 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <button
                    onClick={handleSend}
                    disabled={!inputText.trim()}
                    className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    Send
                  </button>
                </div>
              </div>
            )}

            {/* ── Files tab ──────────────────────────────────────── */}
            {activeTab === "files" && (
              <div className="flex flex-col gap-3">

                {/* Send section */}
                <div className="rounded-xl bg-slate-700/50 border border-slate-600/50 px-4 py-3 flex flex-col gap-2">
                  <p className="text-xs font-semibold uppercase tracking-widest text-slate-400">Send a File</p>

                  {!sendProgress ? (
                    <button
                      onClick={triggerFilePick}
                      disabled={isSending}
                      className="flex items-center justify-center gap-2 w-full rounded-xl bg-blue-600 py-2.5 text-sm font-semibold text-white hover:bg-blue-500 active:scale-95 transition-all disabled:opacity-50"
                    >
                      <span>📂</span> Choose File to Send
                    </button>
                  ) : (
                    <div className="flex flex-col gap-1.5">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-slate-300 truncate max-w-[200px]">{sendProgress.filename}</span>
                        <span className="text-xs font-bold text-blue-400">{sendPct}%</span>
                      </div>
                      <div className="w-full h-2 rounded-full bg-slate-600 overflow-hidden">
                        <div
                          className="h-full rounded-full bg-blue-500 transition-all duration-200"
                          style={{ width: `${sendPct}%` }}
                        />
                      </div>
                      <p className="text-xs text-slate-500 text-center">
                        Chunk {sendProgress.sent} / {sendProgress.total}
                      </p>
                      <button
                        onClick={handleAbortSend}
                        className="text-xs text-red-400 hover:text-red-300 transition-colors self-center"
                      >
                        Abort
                      </button>
                    </div>
                  )}
                </div>

                {/* Received files */}
                <div className="flex flex-col gap-2">
                  <p className="text-xs font-semibold uppercase tracking-widest text-slate-400">
                    Received Files
                    {receivedFiles.length > 0 && ` (${receivedFiles.length})`}
                  </p>

                  {receivedFiles.length === 0 ? (
                    <div className="rounded-xl bg-slate-900/50 border border-slate-700 px-4 py-6 text-center">
                      <p className="text-slate-500 text-sm">No files received yet.</p>
                      <p className="text-slate-600 text-xs mt-1">
                        The remote device must send using the FILE_START/CHUNK/FILE_END protocol.
                      </p>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-2 max-h-56 overflow-y-auto">
                      {receivedFiles.map((f) => (
                        <div
                          key={f.id}
                          className="flex items-center gap-3 rounded-xl bg-slate-700/60 border border-slate-600/40 px-3 py-2.5"
                        >
                          {/* Icon or image thumbnail */}
                          {f.mime.startsWith("image/") ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={f.url}
                              alt={f.name}
                              className="w-10 h-10 rounded-lg object-cover shrink-0 border border-slate-600"
                            />
                          ) : (
                            <span className="text-2xl shrink-0">{fileIcon(f.mime)}</span>
                          )}

                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-semibold text-white truncate">{f.name}</p>
                            <p className="text-xs text-slate-400">{formatBytes(f.originalSize)} · {f.mime.split("/")[1]?.toUpperCase()}</p>
                          </div>

                          <a
                            href={f.url}
                            download={f.name}
                            className="shrink-0 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 active:scale-95 transition-all"
                          >
                            Save
                          </a>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

              </div>
            )}
          </>
        )}

        {/* ── Action buttons ────────────────────────────────────────── */}
        <div className="flex flex-col gap-2">
          {appState !== "connected" && (
            <button
              onClick={handleScan}
              disabled={isBusy || appState === "scanning" || appState === "connecting"}
              className={`w-full rounded-xl px-6 py-3 text-sm font-semibold text-white transition-all
                ${
                  isBusy || appState === "scanning" || appState === "connecting"
                    ? "bg-slate-600 cursor-not-allowed"
                    : "bg-blue-600 hover:bg-blue-500 active:scale-95"
                }`}
            >
              {appState === "scanning" ? "Scanning…"
                : appState === "connecting" ? "Connecting…"
                : appState === "device_list" ? "Rescan"
                : "Scan for Devices"}
            </button>
          )}
          {appState === "connected" && (
            <button
              onClick={handleDisconnect}
              disabled={isBusy}
              className="w-full rounded-xl bg-red-600 px-6 py-3 text-sm font-semibold text-white hover:bg-red-500 active:scale-95 transition-all disabled:opacity-50"
            >
              Disconnect
            </button>
          )}
        </div>

      </div>
    </div>
  );
}

