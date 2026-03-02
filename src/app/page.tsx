"use client";

import { useState, useCallback } from "react";
import { BleClient } from "@capacitor-community/bluetooth-le";

// UUIDs for Battery Service (BLE standard) – full 128-bit form required by the plugin
const BATTERY_SERVICE = "0000180f-0000-1000-8000-00805f9b34fb";
const BATTERY_CHARACTERISTIC = "00002a19-0000-1000-8000-00805f9b34fb";

type AppStatus =
  | "idle"
  | "initializing"
  | "scanning"
  | "connecting"
  | "reading"
  | "done"
  | "error";

export default function Home() {
  const [status, setStatus] = useState<AppStatus>("idle");
  const [statusMessage, setStatusMessage] = useState<string>(
    "Press the button to scan for BLE devices."
  );
  const [batteryLevel, setBatteryLevel] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const connectAndReadBattery = useCallback(async () => {
    setIsLoading(true);
    setBatteryLevel(null);
    let deviceId: string | null = null;

    try {
      // ── Step 1: Initialize BLE ──────────────────────────────────────
      setStatus("initializing");
      setStatusMessage("Initializing Bluetooth...");
      await BleClient.initialize({ androidNeverForLocation: true });

      // ── Step 2: Scan – show picker filtered to Battery Service ──────
      setStatus("scanning");
      setStatusMessage(
        "Scanning for BLE devices... Put your earbuds in PAIRING MODE so they appear in the list."
      );

      const device = await BleClient.requestDevice({
        // No services filter → show ALL nearby BLE devices in the picker.
        // BATTERY_SERVICE listed as optional so we can access it after connecting
        // even if the device didn't advertise it.
        optionalServices: [BATTERY_SERVICE],
      });

      deviceId = device.deviceId;
      setStatusMessage(`Device selected: ${device.name ?? device.deviceId}`);

      // ── Step 3: Connect ─────────────────────────────────────────────
      setStatus("connecting");
      setStatusMessage(`Connecting to ${device.name ?? device.deviceId}...`);

      await BleClient.connect(deviceId, (lostDeviceId) => {
        // Unexpected disconnection callback
        setStatus("error");
        setStatusMessage(`Disconnected unexpectedly from ${lostDeviceId}.`);
        setIsLoading(false);
      });

      setStatusMessage("Connected! Reading Battery Level...");

      // ── Step 4: Read Battery Level characteristic ───────────────────
      setStatus("reading");
      const dataView = await BleClient.read(
        deviceId,
        BATTERY_SERVICE,
        BATTERY_CHARACTERISTIC
      );

      // ── Step 5: Parse the first byte as an unsigned 8-bit integer ───
      const level = dataView.getUint8(0);
      setBatteryLevel(level);
      setStatus("done");
      setStatusMessage("Battery level read successfully.");
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "An unknown error occurred.";
      setStatus("error");
      setStatusMessage(`Error: ${message}`);
    } finally {
      // ── Step 6: Always disconnect cleanly ───────────────────────────
      if (deviceId) {
        try {
          await BleClient.disconnect(deviceId);
        } catch {
          // Ignore disconnect errors (device may already be gone)
        }
      }
      setIsLoading(false);
    }
  }, []);

  /* ─── Derived UI helpers ─────────────────────────────────────────── */
  const statusColor: Record<AppStatus, string> = {
    idle: "text-slate-500",
    initializing: "text-blue-500",
    scanning: "text-blue-500",
    connecting: "text-amber-500",
    reading: "text-amber-500",
    done: "text-emerald-600",
    error: "text-red-500",
  };

  const batteryColor =
    batteryLevel === null
      ? "text-slate-400"
      : batteryLevel > 50
      ? "text-emerald-600"
      : batteryLevel > 20
      ? "text-amber-500"
      : "text-red-500";

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-slate-900 p-6">
      <div className="w-full max-w-sm rounded-2xl bg-slate-800 p-8 shadow-2xl flex flex-col items-center gap-8">
        {/* Header */}
        <div className="text-center">
          <h1 className="text-2xl font-bold text-white tracking-tight">
            BLE Battery Reader
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Connects via Bluetooth Low Energy (BLE) and reads the Battery Service (0x180F).
            <br />
            <span className="text-yellow-400">⚠ Earbuds must be in pairing mode to appear.</span>
          </p>
        </div>

        {/* Battery Display */}
        <div className="flex flex-col items-center gap-1">
          <span className="text-sm font-medium text-slate-400 uppercase tracking-widest">
            Battery Level
          </span>
          <span className={`text-7xl font-black tabular-nums ${batteryColor}`}>
            {batteryLevel !== null ? `${batteryLevel}%` : "--"}
          </span>
        </div>

        {/* Action Button */}
        <button
          onClick={connectAndReadBattery}
          disabled={isLoading}
          className={`w-full rounded-xl px-6 py-4 text-base font-semibold text-white transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:ring-offset-slate-800
            ${
              isLoading
                ? "bg-slate-600 cursor-not-allowed"
                : "bg-blue-600 hover:bg-blue-500 active:scale-95"
            }`}
        >
          {isLoading ? (
            <span className="flex items-center justify-center gap-2">
              <svg
                className="h-5 w-5 animate-spin"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8v8H4z"
                />
              </svg>
              Working...
            </span>
          ) : (
            "Connect & Read Battery"
          )}
        </button>

        {/* Status Message */}
        <div className="w-full rounded-lg bg-slate-700/60 px-4 py-3">
          <p className="text-xs font-semibold uppercase tracking-widest text-slate-500 mb-1">
            Status
          </p>
          <p className={`text-sm font-medium break-words ${statusColor[status]}`}>
            {statusMessage}
          </p>
        </div>
      </div>
    </div>
  );
}
