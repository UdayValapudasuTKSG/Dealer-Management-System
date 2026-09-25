import { customFetch } from "@workspace/api-client-react";

export async function downloadPartsReport(path: string, filename: string, format: "csv" | "pdf") {
  const url = new URL(path, window.location.origin);
  url.searchParams.set("format", format);
  const blob = await customFetch<Blob>(url.toString(), { responseType: "blob", cache: "no-store" });
  const expected = format === "csv" ? "text/csv" : "application/pdf";
  if (!blob.type.includes(expected)) throw new Error(`Could not export ${filename}: unexpected response format.`);
  const blobUrl = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = blobUrl;
    anchor.download = `${filename}.${format}`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
  }
}