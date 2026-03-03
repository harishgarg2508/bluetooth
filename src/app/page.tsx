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

interface DeviceItem {
  id: number;
  name: string;
  size?: number;
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

// Parse device item list from any line-delimited response.
function parseDeviceItems(raw: string): DeviceItem[] {
  const items: DeviceItem[] = [];
  let counter = 0;
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (/^FILE_(START|END|ABORT):/i.test(line) || /^CHUNK:/i.test(line)) continue;
    if (/^FILES:\d+$/i.test(line) || /^\d+$/.test(line)) continue;
    if (/^(OK|ERROR|AT\+)$/i.test(line)) continue;
    let m = line.match(/^\d+[:.\s]\s*(.+?\.\w{1,5})[:\s](\d+)$/i);
    if (m) { items.push({ id: counter++, name: m[1].trim(), size: parseInt(m[2]) }); continue; }
    m = line.match(/^\d+[:.\s]\s*(.+?\.\w{1,5})$/i);
    if (m) { items.push({ id: counter++, name: m[1].trim() }); continue; }
    m = line.match(/^(.+?\.\w{1,5})[:\s](\d+)$/i);
    if (m) { items.push({ id: counter++, name: m[1].trim(), size: parseInt(m[2]) }); continue; }
    m = line.match(/^(.+?\.\w{1,5})$/i);
    if (m) { items.push({ id: counter++, name: m[1].trim() }); continue; }
  }
  return items;
}

// Determine whether received data is binary (contains non-printable bytes)
function isBinaryData(raw: string): boolean {
  for (let i = 0; i < Math.min(raw.length, 32); i++) {
    const c = raw.charCodeAt(i);
    // control chars other than \r \n \t indicate binary
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) return true;
  }
  return false;
}

// Convert string of raw bytes to readable hex string for debug display
function toHexDump(raw: string, maxBytes = 24): string {
  const bytes = Math.min(raw.length, maxBytes);
  let out = "";
  for (let i = 0; i < bytes; i++) {
    out += raw.charCodeAt(i).toString(16).padStart(2, "0").toUpperCase() + " ";
  }
  if (raw.length > maxBytes) out += "...";
  return out.trim();
}

// Parse battery from BINARY packet (Orange Wireless Glasses SDK):
//   loadData[6] = 0x05 → glasses battery report
//   loadData[7] = battery level (0–100)
//   loadData[8] = charging status (0=not charging, non-zero=charging)
function parseBatteryBinary(raw: string): { level: number; charging: boolean } | null {
  // Primary: known header length — cmdType at index 6
  if (raw.length >= 9 && raw.charCodeAt(6) === 0x05) {
    const level = raw.charCodeAt(7);
    const charging = raw.charCodeAt(8) !== 0;
    if (level >= 0 && level <= 100) return { level, charging };
  }
  // Fallback: scan the whole packet for 0x05 cmdType byte
  // (handles variable-length packet headers / framing variants)
  for (let i = 0; i < raw.length - 2; i++) {
    if (raw.charCodeAt(i) === 0x05) {
      const level = raw.charCodeAt(i + 1);
      const charging = raw.charCodeAt(i + 2) !== 0;
      if (level > 0 && level <= 100) return { level, charging };
    }
  }
  return null;
}

// Parse un-synced media counts from binary response to glassesControl([0x02, 0x04]).
// Response cmdType is 0x04; counts at loadData[7], [8], [9].
interface MediaCounts { images: number; videos: number; recordings: number; }
function parseMediaCounts(raw: string): MediaCounts | null {
  if (!isBinaryData(raw)) return null;
  // Primary: cmdType 0x04 at index 6
  if (raw.length >= 10 && raw.charCodeAt(6) === 0x04) {
    return {
      images:     raw.charCodeAt(7),
      videos:     raw.charCodeAt(8),
      recordings: raw.charCodeAt(9),
    };
  }
  // Fallback: scan for 0x04 byte followed by plausible counts
  for (let i = 0; i < raw.length - 3; i++) {
    if (raw.charCodeAt(i) === 0x04) {
      const img = raw.charCodeAt(i + 1);
      const vid = raw.charCodeAt(i + 2);
      const rec = raw.charCodeAt(i + 3);
      if ((img + vid + rec) > 0 && img < 10000 && vid < 10000 && rec < 10000)
        return { images: img, videos: vid, recordings: rec };
    }
  }
  return null;
}

// Parse battery % from any SPP/RFCOMM TEXT string — intentionally broad.
function parseBatteryText(raw: string): number | null {
  const s = raw.trim();
  const patterns: RegExp[] = [
    /bat(?:tery)?\s*[=:]\s*(\d{1,3})/i,
    /\+cbc:\d+,(\d{1,3})/i,
    /power\s*[=:]\s*(\d{1,3})/i,
    /charge\s*[=:]\s*(\d{1,3})/i,
    /level\s*[=:]\s*(\d{1,3})/i,
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

// Unified parser — tries binary first, falls back to text
function parseBattery(raw: string): { level: number; charging: boolean } | null {
  const bin = parseBatteryBinary(raw);
  if (bin) return bin;
  const txt = parseBatteryText(raw);
  if (txt !== null) return { level: txt, charging: false };
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
  const [isCharging, setIsCharging] = useState(false);
  const [activeTab, setActiveTab] = useState<"terminal" | "files" | "import">("terminal");
  const [receivedFiles, setReceivedFiles] = useState<ReceivedFile[]>([]);
  const [sendProgress, setSendProgress] = useState<SendProgress | null>(null);
  const [isSending, setIsSending] = useState(false);
  // Battery helpers
  const [lastRxLine, setLastRxLine] = useState("");
  const [batCmd, setBatCmd] = useState("");
  const [showBatCmdEdit, setShowBatCmdEdit] = useState(false);
  const [manualBatInput, setManualBatInput] = useState("");
  // Import
  const [deviceItems, setDeviceItems] = useState<DeviceItem[]>([]);
  const [isListing, setIsListing] = useState(false);
  const [listCmd, setListCmd] = useState("LIST\r\n");
  const [getCmd, setGetCmd] = useState("GET:");
  const [importingItem, setImportingItem] = useState<string | null>(null);
  // Media counts (from binary glassesControl [0x02, 0x04] response)
  const [mediaCounts, setMediaCounts] = useState<MediaCounts | null>(null);
  const [isCheckingMedia, setIsCheckingMedia] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);
  const listenerRef = useRef<{ remove: () => void } | null>(null);
  const rxBufferRef = useRef<string>("");
  const abortSendRef = useRef<boolean>(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const receivedFilesRef = useRef<ReceivedFile[]>([]);
  const listBufferRef = useRef<string>("");
  const listTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isListingRef = useRef<boolean>(false);

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
        // Auto-clear import spinner + switch to files tab
        setImportingItem((prev) => (prev === rawName ? null : prev));
        setActiveTab("files");
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
            const data = event.data;
            addLog("rx", data);
            // Show first non-empty line (or hex dump if binary) as last device response
            if (isBinaryData(data)) {
              setLastRxLine("[bin] " + toHexDump(data));
            } else {
              const firstLine = data.split(/\r?\n/)[0].trim().slice(0, 80);
              if (firstLine) setLastRxLine(firstLine);
            }
            // Auto-parse battery (binary cmdType 0x05 or text fallback)
            const parsed = parseBattery(data);
            if (parsed !== null) {
              setBatteryLevel(parsed.level);
              setIsCharging(parsed.charging);
            }
            // Auto-parse media counts (binary cmdType 0x04 response to [0x02,0x04])
            const counts = parseMediaCounts(data);
            if (counts !== null) {
              setMediaCounts(counts);
              setIsCheckingMedia(false);
              addLog("sys", `Media: ${counts.images} image(s), ${counts.videos} video(s), ${counts.recordings} recording(s)`);
            }
            // File frame assembly
            rxBufferRef.current += data;
            processBuffer();
            // Listing mode: accumulate lines and debounce-finalize after 800 ms silence
            if (isListingRef.current) {
              listBufferRef.current += data;
              if (listTimeoutRef.current) clearTimeout(listTimeoutRef.current);
              listTimeoutRef.current = setTimeout(() => {
                isListingRef.current = false;
                setIsListing(false);
                const items = parseDeviceItems(listBufferRef.current);
                setDeviceItems(items);
                listBufferRef.current = "";
                addLog("sys", `Device list: ${items.length} item(s) found.`);
              }, 800);
            }
          }
        );
        listenerRef.current = handle;

        setConnectedDevice(device);
        setLog([]);
        setBatteryLevel(null);
        setIsCharging(false);
        setLastRxLine("");
        setMediaCounts(null);
        rxBufferRef.current = "";
        receivedFilesRef.current = [];
        setReceivedFiles([]);
        setDeviceItems([]);
        setImportingItem(null);
        isListingRef.current = false;
        listBufferRef.current = "";
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
    listBufferRef.current = "";
    if (listTimeoutRef.current) clearTimeout(listTimeoutRef.current);
    isListingRef.current = false;
    abortSendRef.current = true;
    setReceivedFiles([]);
    setSendProgress(null);
    setIsSending(false);
    setDeviceItems([]);
    setIsListing(false);
    setImportingItem(null);
    setLastRxLine("");
    setConnectedDevice(null);
    setBatteryLevel(null);
    setIsCharging(false);
    setMediaCounts(null);
    setAppState("idle");
    setDevices([]);
    setStatusMsg("Disconnected. Tap 'Scan' to connect again.");
    setIsBusy(false);
  }, [addLog]);

  // ── Request battery level from device ─────────────────────────────
  // Sends binary syncBattery command [0x02, 0x05] per Orange Wireless SDK.
  // If the user has typed a custom AT command in the bat cmd field, that is
  // sent instead (allows fallback for non-SDK-standard glasses).
  const handleRequestBattery = useCallback(async () => {
    try {
      if (batCmd.trim().length > 0) {
        // User has a custom text command — send it
        const cmd = batCmd.replace(/\\r/g, "\r").replace(/\\n/g, "\n");
        await BluetoothCommunication.sendData({ data: cmd });
        addLog("tx", `Battery cmd (custom): ${JSON.stringify(batCmd.trim())}`);
      } else {
        // Default: binary syncBattery() per SDK
        const binary = String.fromCharCode(0x02, 0x05);
        await BluetoothCommunication.sendData({ data: binary });
        addLog("tx", "Battery sync: [02 05] (binary syncBattery)");
      }
    } catch (err: unknown) {
      addLog("sys", `Battery request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [addLog, batCmd]);

  // ── Check un-synced media count [0x02, 0x04] ──────────────────────
  const handleCheckMedia = useCallback(async () => {
    setIsCheckingMedia(true);
    try {
      const binary = String.fromCharCode(0x02, 0x04);
      await BluetoothCommunication.sendData({ data: binary });
      addLog("tx", "Media check: [02 04] (glassesControl)");
      // Safety timeout: clear spinner after 10 s if no response
      setTimeout(() => setIsCheckingMedia(false), 10000);
    } catch (err: unknown) {
      setIsCheckingMedia(false);
      addLog("sys", `Media check failed: ${err instanceof Error ? err.message : String(err)}`);
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

  // ── List files on the remote device ───────────────────────────────
  const handleListFiles = useCallback(async () => {
    isListingRef.current = true;
    listBufferRef.current = "";
    setIsListing(true);
    setDeviceItems([]);
    try {
      const cmd = listCmd.replace(/\\r/g, "\r").replace(/\\n/g, "\n");
      await BluetoothCommunication.sendData({ data: cmd });
      addLog("tx", `List command: ${JSON.stringify(listCmd.trim())}`);
    } catch (err: unknown) {
      isListingRef.current = false;
      setIsListing(false);
      addLog("sys", `List failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [listCmd, addLog]);

  // ── Request a single file from the device ─────────────────────────
  const handleImportItem = useCallback(async (itemName: string) => {
    setImportingItem(itemName);
    try {
      const prefix = getCmd.replace(/\\r/g, "\r").replace(/\\n/g, "\n");
      await BluetoothCommunication.sendData({ data: `${prefix}${itemName}\r\n` });
      addLog("tx", `Import request: ${getCmd}${itemName}`);
      // Safety: clear spinner after 30 s if file never arrives
      setTimeout(() => setImportingItem((prev) => (prev === itemName ? null : prev)), 30000);
    } catch (err: unknown) {
      setImportingItem(null);
      addLog("sys", `Import failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [getCmd, addLog]);

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
            <div className="rounded-xl bg-slate-700/50 border border-slate-600/50 overflow-hidden">
              {/* Main row */}
              <div className="px-4 py-3 flex items-center gap-4">
                <div className="w-12 h-6 rounded border-2 border-slate-500 relative flex items-center px-0.5 shrink-0">
                  <div className="absolute -right-[5px] top-1/2 -translate-y-1/2 w-1.5 h-3 rounded-r border border-slate-500 bg-slate-700" />
                  <div
                    className={`h-3.5 rounded-sm transition-all duration-500 ${batteryBarColor}`}
                    style={{ width: batteryLevel !== null ? `${batteryLevel}%` : "0%" }}
                  />
                  {isCharging && (
                    <span className="absolute inset-0 flex items-center justify-center text-[9px] leading-none text-white font-bold select-none">
                      &#9889;
                    </span>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">
                    Battery{isCharging && <span className="ml-1.5 text-yellow-400 font-bold">&#9889; Charging</span>}
                  </p>
                  <p className={`text-2xl font-black tabular-nums leading-none mt-0.5 ${batteryTextColor}`}>
                    {batteryLevel !== null ? `${batteryLevel}%` : "--"}
                  </p>
                  {lastRxLine && (
                    <p
                      className={`text-[10px] mt-0.5 truncate font-mono ${
                        lastRxLine.startsWith("[bin]") ? "text-amber-400/70" : "text-slate-500"
                      }`}
                      title={lastRxLine}
                    >
                      {lastRxLine.startsWith("[bin]") ? lastRxLine : `\u21A9 ${lastRxLine}`}
                    </p>
                  )}
                </div>
                <div className="flex flex-col items-end gap-1 shrink-0">
                  <button
                    onClick={handleRequestBattery}
                    className="rounded-lg bg-slate-600 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:bg-slate-500 active:scale-95 transition-all"
                  >
                    Request
                  </button>
                  <button
                    onClick={() => setShowBatCmdEdit((v) => !v)}
                    className="text-[10px] text-slate-500 hover:text-slate-300 transition-colors"
                  >
                    {showBatCmdEdit ? "▲ hide" : "▼ set cmd"}
                  </button>
                </div>
              </div>
              {/* Collapsible command + manual-set row */}
                  {showBatCmdEdit && (
                    <div className="border-t border-slate-600/40 px-3 py-2.5 flex flex-col gap-2">
                      <p className="text-[10px] text-slate-500 leading-relaxed">
                        Default sends binary
                        <span className="font-mono text-slate-400 mx-1">[02 05]</span>
                        (<span className="text-slate-400">syncBattery()</span> — Orange SDK).
                        Enter a custom AT command below to override:
                      </p>
                      <div className="flex gap-2 items-center">
                        <input
                          value={batCmd}
                          onChange={(e) => setBatCmd(e.target.value)}
                          placeholder="leave empty for binary [02 05]"
                          className="flex-1 rounded-lg bg-slate-900 px-2 py-1 text-xs text-white font-mono placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-blue-500"
                        />
                        {batCmd.trim().length > 0 && (
                          <button
                            onClick={() => setBatCmd("")}
                            className="text-[10px] text-red-500/70 hover:text-red-400 transition-colors"
                          >
                            Clear
                          </button>
                        )}
                      </div>
                      <div className="flex gap-2 items-center">
                        <span className="text-[10px] text-slate-500 w-16 shrink-0">Set manually:</span>
                        <input
                          type="number" min={0} max={100}
                          value={manualBatInput}
                          onChange={(e) => setManualBatInput(e.target.value)}
                          placeholder="0–100"
                          className="w-16 rounded-lg bg-slate-900 px-2 py-1 text-xs text-white text-center focus:outline-none focus:ring-1 focus:ring-blue-500"
                        />
                        <button
                          onClick={() => {
                            const v = parseInt(manualBatInput, 10);
                            if (!isNaN(v) && v >= 0 && v <= 100) { setBatteryLevel(v); setManualBatInput(""); }
                          }}
                          className="rounded-lg bg-slate-600 px-3 py-1 text-[10px] font-semibold text-white hover:bg-slate-500"
                        >
                          Set
                        </button>
                      </div>
                    </div>
                  )}
            </div>

            {/* ── Tab bar ────────────────────────────────────────── */}
            <div className="flex rounded-xl bg-slate-900/60 p-1 gap-1">
              {(["terminal", "files", "import"] as const).map((tab) => (
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
                    <span className="ml-1 rounded-full bg-blue-500 px-1.5 py-0.5 text-[10px] font-bold text-white">
                      {receivedFiles.length}
                    </span>
                  )}
                  {tab === "import" && (mediaCounts || deviceItems.length > 0) && (
                    <span className="ml-1 rounded-full bg-violet-500 px-1.5 py-0.5 text-[10px] font-bold text-white">
                      {mediaCounts
                        ? mediaCounts.images + mediaCounts.videos + mediaCounts.recordings
                        : deviceItems.length}
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

            {/* ── Import tab ─────────────────────────────────────── */}
            {activeTab === "import" && (
              <div className="flex flex-col gap-3">

                {/* ── Media counts (binary [0x02, 0x04] protocol) ── */}
                <div className="rounded-xl bg-slate-700/50 border border-slate-600/50 px-4 py-3 flex flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold uppercase tracking-widest text-slate-400">Un-synced Media</p>
                    <button
                      onClick={handleCheckMedia}
                      disabled={isCheckingMedia}
                      className="flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-500 active:scale-95 transition-all disabled:opacity-60"
                    >
                      {isCheckingMedia ? (
                        <>
                          <svg className="h-3 w-3 animate-spin" fill="none" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                          </svg>
                          Checking…
                        </>
                      ) : "↻ Check"}
                    </button>
                  </div>
                  {mediaCounts ? (
                    <div className="grid grid-cols-3 gap-2">
                      {[
                        { icon: "🖼️", label: "Images",     count: mediaCounts.images },
                        { icon: "🎥", label: "Videos",     count: mediaCounts.videos },
                        { icon: "🎙️", label: "Recordings", count: mediaCounts.recordings },
                      ].map(({ icon, label, count }) => (
                        <div key={label} className="rounded-lg bg-slate-900/60 border border-slate-700 px-2 py-2.5 text-center">
                          <p className="text-xl">{icon}</p>
                          <p className="text-lg font-black text-white tabular-nums leading-none mt-1">{count}</p>
                          <p className="text-[10px] text-slate-500 mt-0.5">{label}</p>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-slate-500 text-center py-1">
                      Tap <span className="text-violet-400">↻ Check</span> to query glasses via binary command{" "}
                      <span className="font-mono text-slate-400">[02 04]</span>
                    </p>
                  )}
                  <p className="text-[10px] text-slate-600 leading-relaxed">
                    Uses <span className="text-slate-500 font-mono">glassesControl([0x02, 0x04])</span> — Orange Wireless SDK.
                    The glasses respond with image/video/recording counts automatically parsed from the binary reply.
                  </p>
                </div>

                {/* ── Manual file list (text protocol fallback) ── */}
                <div className="rounded-xl bg-slate-700/50 border border-slate-600/50 px-4 py-3 flex flex-col gap-2">
                  <p className="text-xs font-semibold uppercase tracking-widest text-slate-400">Manual File List</p>
                  <div className="flex gap-2 items-center">
                    <span className="text-[10px] text-slate-500 w-16 shrink-0">List cmd:</span>
                    <input
                      value={listCmd}
                      onChange={(e) => setListCmd(e.target.value)}
                      placeholder="LIST\r\n"
                      className="flex-1 rounded-lg bg-slate-900 px-2 py-1 text-xs text-white font-mono placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-violet-500"
                    />
                  </div>
                  <div className="flex gap-2 items-center">
                    <span className="text-[10px] text-slate-500 w-16 shrink-0">Get prefix:</span>
                    <input
                      value={getCmd}
                      onChange={(e) => setGetCmd(e.target.value)}
                      placeholder="GET:"
                      className="flex-1 rounded-lg bg-slate-900 px-2 py-1 text-xs text-white font-mono placeholder-slate-600 focus:outline-none focus:ring-1 focus:ring-violet-500"
                    />
                  </div>
                  <button
                    onClick={handleListFiles}
                    disabled={isListing}
                    className="flex items-center justify-center gap-2 w-full rounded-xl bg-slate-600 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-500 active:scale-95 transition-all disabled:opacity-60"
                  >
                    {isListing ? (
                      <>
                        <svg className="h-3.5 w-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                        </svg>
                        Fetching list…
                      </>
                    ) : (
                      "↻ Refresh List"
                    )}
                  </button>
                </div>

                {/* Item list */}
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold uppercase tracking-widest text-slate-400">On Device</p>
                    {deviceItems.length > 0 && (
                      <span className="rounded-full bg-violet-500/20 border border-violet-500/30 px-2 py-0.5 text-[11px] font-bold text-violet-300">
                        {deviceItems.length} item{deviceItems.length !== 1 ? "s" : ""}
                      </span>
                    )}
                  </div>

                  {deviceItems.length === 0 ? (
                    <div className="rounded-xl bg-slate-900/50 border border-slate-700 px-4 py-6 text-center">
                      <p className="text-slate-500 text-sm">No items listed yet.</p>
                      <p className="text-slate-600 text-xs mt-1">
                        Set the List command above and tap
                        <span className="text-violet-400"> ↻ Refresh List</span>.
                        <br />The terminal shows raw responses to help find the right command.
                      </p>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-2 max-h-64 overflow-y-auto">
                      {deviceItems.map((item) => (
                        <div
                          key={item.id}
                          className="flex items-center gap-3 rounded-xl bg-slate-700/60 border border-slate-600/40 px-3 py-2.5"
                        >
                          <span className="text-xl shrink-0">{fileIcon(mimeOf(item.name))}</span>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-semibold text-white truncate">{item.name}</p>
                            {item.size !== undefined && (
                              <p className="text-xs text-slate-400">{formatBytes(item.size)}</p>
                            )}
                          </div>
                          <button
                            onClick={() => handleImportItem(item.name)}
                            disabled={importingItem === item.name}
                            className={`shrink-0 rounded-lg px-3 py-1.5 text-xs font-semibold transition-all active:scale-95
                              ${
                                importingItem === item.name
                                  ? "bg-slate-600 text-slate-400 cursor-wait"
                                  : "bg-violet-600 text-white hover:bg-violet-500"
                              }`}
                          >
                            {importingItem === item.name ? (
                              <svg className="h-3.5 w-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                              </svg>
                            ) : "Import"}
                          </button>
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

