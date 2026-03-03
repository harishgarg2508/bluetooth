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

let logCounter = 0;

// Parse a battery percentage out of any SPP/RFCOMM data string.
// Recognises: "85%", "battery:85", "bat=85", "+CBC:0,85", standalone "85"
function parseBattery(raw: string): number | null {
  const s = raw.toLowerCase().trim();
  // Pattern: optional label then digits
  const patterns = [
    /bat(?:tery)?\s*[=:]\s*(\d{1,3})/,  // battery:85  bat=85
    /\+cbc:\d+,(\d{1,3})/,              // AT+CBC: 0,85
    /(\d{1,3})\s*%/,                    // 85%
    /^(\d{1,3})$/,                      // bare number
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
  const logEndRef = useRef<HTMLDivElement>(null);
  const listenerRef = useRef<{ remove: () => void } | null>(null);

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
            // Auto-detect battery level in any received string
            const parsed = parseBattery(event.data);
            if (parsed !== null) setBatteryLevel(parsed);
          }
        );
        listenerRef.current = handle;

        setConnectedDevice(device);
        setLog([]);
        setBatteryLevel(null);
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

  // ── Key-down on input (Enter to send) ──────────────────────────────
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") handleSend();
    },
    [handleSend]
  );

  /* ─── Status colour ─────────────────────────────────────────────── */
  const stateColor: Record<AppState, string> = {
    idle: "text-slate-400",
    scanning: "text-blue-400",
    device_list: "text-amber-400",
    connecting: "text-amber-400",
    connected: "text-emerald-400",
    error: "text-red-400",
  };

  /* ─── Battery colour & icon helpers ───────────────────────────── */
  const batteryBarColor =
    batteryLevel === null
      ? "bg-slate-600"
      : batteryLevel > 50
      ? "bg-emerald-400"
      : batteryLevel > 20
      ? "bg-amber-400"
      : "bg-red-500";

  const batteryTextColor =
    batteryLevel === null
      ? "text-slate-500"
      : batteryLevel > 50
      ? "text-emerald-400"
      : batteryLevel > 20
      ? "text-amber-400"
      : "text-red-400";

  /* ─── Log entry colour ──────────────────────────────────────────── */
  const logColor = (dir: LogEntry["dir"]) =>
    dir === "rx"
      ? "text-emerald-300"
      : dir === "tx"
      ? "text-sky-300"
      : "text-slate-400";

  const logPrefix = (dir: LogEntry["dir"]) =>
    dir === "rx" ? "RX ← " : dir === "tx" ? "TX → " : "   # ";

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-slate-900 p-4">
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
          <p className="text-xs font-semibold uppercase tracking-widest text-slate-500 mb-0.5">
            Status
          </p>
          <p className={`text-sm font-medium break-words ${stateColor[appState]}`}>
            {statusMsg}
          </p>
        </div>

        {/* ── Device list ──────────────────────────────────────────── */}
        {appState === "device_list" && (
          <div className="flex flex-col gap-2">
            <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">
              Paired Devices
            </p>
            {devices.map((d) => (
              <button
                key={d.address}
                onClick={() => handleConnect(d)}
                disabled={isBusy}
                className="flex items-center justify-between rounded-xl bg-slate-700 px-4 py-3 text-left hover:bg-slate-600 active:scale-[0.98] transition-all disabled:opacity-50"
              >
                <span className="text-sm font-semibold text-white">
                  {d.name || "(unknown)"}
                </span>
                <span className="text-xs text-slate-400 font-mono">{d.address}</span>
              </button>
            ))}
          </div>
        )}

        {/* ── Battery widget (connected state) ─────────────────────── */}
        {appState === "connected" && (
          <div className="rounded-xl bg-slate-700/50 px-4 py-3 flex items-center gap-4 border border-slate-600/50">
            {/* Battery icon */}
            <div className="relative flex items-center">
              {/* Outer shell */}
              <div className="w-12 h-6 rounded border-2 border-slate-500 relative flex items-center px-0.5">
                {/* Positive terminal nub */}
                <div className="absolute -right-[5px] top-1/2 -translate-y-1/2 w-1.5 h-3 rounded-r border border-slate-500 bg-slate-700" />
                {/* Fill bar */}
                <div
                  className={`h-3.5 rounded-sm transition-all duration-500 ${batteryBarColor}`}
                  style={{ width: batteryLevel !== null ? `${batteryLevel}%` : "0%" }}
                />
              </div>
            </div>

            {/* Text */}
            <div className="flex-1">
              <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">Battery</p>
              <p className={`text-2xl font-black tabular-nums leading-none mt-0.5 ${batteryTextColor}`}>
                {batteryLevel !== null ? `${batteryLevel}%` : "--"}
              </p>
            </div>

            {/* Request button */}
            <button
              onClick={handleRequestBattery}
              className="rounded-lg bg-slate-600 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:bg-slate-500 active:scale-95 transition-all"
            >
              Request
            </button>
          </div>
        )}

        {/* ── Terminal log (connected state) ───────────────────────── */}
        {appState === "connected" && (
          <div className="flex flex-col gap-3">
            {/* Log window */}
            <div className="h-52 overflow-y-auto rounded-xl bg-slate-900 px-3 py-2 font-mono text-xs space-y-0.5 border border-slate-700">
              {log.length === 0 && (
                <p className="text-slate-600 italic">No data yet…</p>
              )}
              {log.map((entry) => (
                <p key={entry.id} className={logColor(entry.dir)}>
                  <span className="text-slate-600">{logPrefix(entry.dir)}</span>
                  {entry.text}
                </p>
              ))}
              <div ref={logEndRef} />
            </div>

            {/* Send input */}
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

        {/* ── Action buttons ────────────────────────────────────────── */}
        <div className="flex flex-col gap-2">
          {appState !== "connected" && (
            <button
              onClick={handleScan}
              disabled={isBusy || appState === "scanning" || appState === "connecting"}
              className={`w-full rounded-xl px-6 py-3 text-sm font-semibold text-white transition-all
                ${isBusy || appState === "scanning" || appState === "connecting"
                  ? "bg-slate-600 cursor-not-allowed"
                  : "bg-blue-600 hover:bg-blue-500 active:scale-95"
                }`}
            >
              {appState === "scanning"
                ? "Scanning…"
                : appState === "connecting"
                ? "Connecting…"
                : appState === "device_list"
                ? "Rescan"
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

