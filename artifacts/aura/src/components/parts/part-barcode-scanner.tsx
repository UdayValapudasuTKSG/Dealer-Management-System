import * as React from "react";
import { BrowserMultiFormatReader, type IScannerControls } from "@zxing/browser";
import { ScanBarcode } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

export interface PartBarcodeScannerProps {
  /** Called once for each scan. The parent can use the value to resolve a part. */
  onScan: (value: string) => void;
  disabled?: boolean;
}

/**
 * Mobile-friendly UPC/Code 128 scanner for receiving, issuing, transfer, and
 * picking workflows. A manual entry path is always available for devices
 * without a camera or where camera permission is unavailable.
 */
export function PartBarcodeScanner({ onScan, disabled = false }: PartBarcodeScannerProps) {
  const [open, setOpen] = React.useState(false);
  const [manualValue, setManualValue] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [camera, setCamera] = React.useState(false);
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const controlsRef = React.useRef<IScannerControls | null>(null);
  const lastReadRef = React.useRef<{ value: string; at: number } | null>(null);

  const stopCamera = React.useCallback(() => {
    controlsRef.current?.stop();
    controlsRef.current = null;
    const video = videoRef.current;
    const stream = video?.srcObject;
    if (video && stream instanceof MediaStream) {
      stream.getTracks().forEach((track) => track.stop());
      video.srcObject = null;
    }
  }, []);

  const deliver = React.useCallback(
    (rawValue: string) => {
      const value = rawValue.trim();
      if (!value) return;
      const previous = lastReadRef.current;
      // ZXing can report the same frame repeatedly. Ignore repeats briefly,
      // while still allowing a later scan of the same part.
      if (previous && previous.value === value && Date.now() - previous.at < 1500) return;
      lastReadRef.current = { value, at: Date.now() };
      stopCamera();
      setOpen(false);
      setManualValue("");
      setError(null);
      onScan(value);
    },
    [onScan, stopCamera],
  );

  React.useEffect(() => {
    if (!open || !camera) {
      stopCamera();
      return;
    }

    setError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("Camera access is not supported in this browser. Enter the barcode manually below.");
      return;
    }

    let cancelled = false;
    const reader = new BrowserMultiFormatReader();
    const start = async () => {
      try {
        const controls = await reader.decodeFromConstraints(
          { video: { facingMode: { ideal: "environment" } }, audio: false },
          videoRef.current!,
          (result) => {
            if (!cancelled && result) deliver(result.getText());
          },
        );
        if (cancelled) controls.stop();
        else controlsRef.current = controls;
      } catch {
        if (!cancelled) {
          setError("Camera permission was denied or the camera could not be opened. Enter the barcode manually below.");
        }
      }
    };
    void start();

    return () => {
      cancelled = true;
      stopCamera();
    };
  }, [deliver, open, camera, stopCamera]);

  React.useEffect(() => () => stopCamera(), [stopCamera]);

  return (
    <>
      <Button type="button" variant="outline" onClick={() => { setCamera(false); setManualValue(""); setError(null); lastReadRef.current = null; setOpen(true); }} disabled={disabled} aria-label="Scan part barcode">
        <ScanBarcode aria-hidden="true" />
        Scan barcode
      </Button>

      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) stopCamera();
          setOpen(nextOpen);
        }}
      >
        <DialogContent className="w-[calc(100%-2rem)] max-w-md" onOpenAutoFocus={event => { event.preventDefault(); inputRef.current?.focus(); }}>
          <DialogHeader>
            <DialogTitle>Scan part barcode</DialogTitle>
            <DialogDescription>Scan with your USB or Bluetooth scanner in keyboard (HID) mode, then press Enter if needed. You can also type a code or use a camera.</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <Button type="button" variant="outline" onClick={() => setCamera(!camera)}>{camera ? "Stop camera" : "Use camera instead"}</Button>
            {camera && <div className="relative aspect-[4/3] overflow-hidden rounded-md border border-border bg-black">
              <video ref={videoRef} className="h-full w-full object-cover" autoPlay muted playsInline aria-label="Barcode camera preview" />
              <div className="pointer-events-none absolute inset-[18%_8%] rounded border-2 border-primary/80" aria-hidden="true" />
            </div>}
            {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
            <div className="flex gap-2">
              <Input
                ref={inputRef}
                value={manualValue}
                onChange={(event) => setManualValue(event.target.value)}
                autoFocus
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    event.stopPropagation();
                    deliver(manualValue);
                  }
                }}
                placeholder="Scan or enter barcode / SKU"
                aria-label="Barcode value"
                autoComplete="off"
                inputMode="text"
              />
              <Button type="button" onClick={() => deliver(manualValue)} disabled={!manualValue.trim()}>Use code</Button>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}