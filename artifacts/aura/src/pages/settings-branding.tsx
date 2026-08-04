import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetDealerBranding,
  useUpdateDealerBranding,
  getGetDealerBrandingQueryKey,
  getGetCurrentUserQueryKey,
} from "@workspace/api-client-react";
import { useUpload } from "@workspace/object-storage-web";
import { Page } from "@/components/layout/page";
import { PageHero } from "@/components/layout/page-hero";
import { SettingsTabs } from "@/components/settings-nav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useAuthz } from "@/lib/auth";
import { Loader2, Paintbrush, Sparkles, Trash2, Upload } from "lucide-react";

const MAX_LOGO_BYTES = 2 * 1024 * 1024; // 2MB is plenty for a logo

/**
 * The PDF engine can only embed PNG/JPEG, so WEBP (and other image formats)
 * are converted to PNG in the browser before upload — otherwise the logo
 * would show in the app but silently disappear from printed documents.
 */
async function toPdfCompatible(file: File): Promise<File> {
  if (file.type === "image/png" || file.type === "image/jpeg") return file;
  try {
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("conversion failed"))),
        "image/png",
      ),
    );
    return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".png", {
      type: "image/png",
    });
  } catch {
    // Conversion unsupported for this format/browser — upload the original;
    // the app still renders it and PDFs fall back to the name-only header.
    return file;
  }
}

/**
 * GM-only white-label settings: dealership display name + logo shown across
 * the app shell and printed on invoices, quotations, receipts and handover
 * documents. Clearing both falls back to the default AURA branding.
 */
export default function SettingsBranding() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { activeDealer, me } = useAuthz();
  const isGm = !!activeDealer?.isGeneralManager || !!me?.isSuperAdmin;

  const { data: branding, isLoading } = useGetDealerBranding({
    query: { enabled: isGm },
  } as never);
  const [brandName, setBrandName] = useState("");
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  // Re-hydrate whenever the loaded branding changes (including after a
  // dealer switch, which refetches with the new X-Dealer-Id) so the form
  // never shows — or saves — another dealership's values.
  const hydratedFor = useRef<number | null>(null);
  useEffect(() => {
    if (branding && hydratedFor.current !== branding.dealerId) {
      hydratedFor.current = branding.dealerId;
      setBrandName(branding.brandName ?? "");
      setLogoUrl(branding.logoUrl ?? null);
    }
  }, [branding]);

  const fileInput = useRef<HTMLInputElement>(null);
  const { uploadFile, isUploading } = useUpload();

  const save = useUpdateDealerBranding({
    mutation: {
      onSuccess: () => {
        toast({
          title: "Branding saved",
          description: "The app and printed documents now carry your dealership identity.",
        });
        qc.invalidateQueries({ queryKey: getGetDealerBrandingQueryKey() });
        qc.invalidateQueries({ queryKey: getGetCurrentUserQueryKey() });
      },
      onError: (e) =>
        toast({
          title: "Could not save branding",
          description: e instanceof Error ? e.message : undefined,
          variant: "destructive",
        }),
    },
  });

  const onPickLogo = async (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast({ title: "Logo must be an image", variant: "destructive" });
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      toast({ title: "Logo is too large (max 2MB)", variant: "destructive" });
      return;
    }
    const res = await uploadFile(await toPdfCompatible(file));
    if (res?.objectPath) setLogoUrl(res.objectPath);
  };

  if (!isGm) {
    return (
      <Page>
        <PageHero title="Branding" subtitle="White-label your dealership" icon={Paintbrush} />
        <SettingsTabs />
        <div className="px-5 md:px-8 text-sm text-muted-foreground">
          Only the general manager can manage dealership branding.
        </div>
      </Page>
    );
  }

  const previewName =
    brandName.trim() || activeDealer?.dealerName || "AURA.OS";

  return (
    <Page>
      <PageHero
        title="Branding"
        subtitle="White-label the app and printed documents with your dealership identity"
        icon={Paintbrush}
      />
      <SettingsTabs />
      <div className="px-5 md:px-8 pb-10 grid gap-6 lg:grid-cols-2 max-w-4xl">
        <div className="rounded-2xl border border-border bg-card p-6 space-y-5">
          <div>
            <div className="text-sm font-semibold">Dealership brand name</div>
            <p className="text-xs text-muted-foreground mt-1">
              Shown in the sidebar and printed on invoices, quotations and
              receipts. Leave blank to use the default AURA branding in the
              app; printed documents then carry your registered dealership
              name.
            </p>
            <Input
              className="mt-3"
              value={brandName}
              maxLength={80}
              placeholder={activeDealer?.dealerName ?? "e.g. Beharry Automotive"}
              onChange={(e) => setBrandName(e.target.value)}
            />
          </div>

          <div>
            <div className="text-sm font-semibold">Logo</div>
            <p className="text-xs text-muted-foreground mt-1">
              PNG, WEBP or JPG (max 2MB) — transparent backgrounds work best.
              Other formats are converted automatically so the logo also
              prints on documents.
            </p>
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml,image/avif"
              className="hidden"
              onChange={(e) => void onPickLogo(e.target.files?.[0])}
            />
            <div className="mt-3 flex items-center gap-3">
              <Button
                variant="outline"
                size="sm"
                disabled={isUploading}
                onClick={() => fileInput.current?.click()}
              >
                {isUploading ? (
                  <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                ) : (
                  <Upload className="h-4 w-4 mr-1.5" />
                )}
                {logoUrl ? "Replace logo" : "Upload logo"}
              </Button>
              {logoUrl && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-red-400 hover:text-red-300"
                  onClick={() => setLogoUrl(null)}
                >
                  <Trash2 className="h-4 w-4 mr-1.5" />
                  Remove
                </Button>
              )}
            </div>
          </div>

          <Button
            disabled={save.isPending || isUploading || isLoading}
            onClick={() =>
              save.mutate({
                data: {
                  brandName: brandName.trim() ? brandName.trim() : null,
                  logoUrl,
                },
              })
            }
          >
            {save.isPending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
            Save branding
          </Button>
        </div>

        {/* Live preview of the sidebar brand block */}
        <div className="rounded-2xl border border-border bg-card p-6">
          <div className="text-sm font-semibold mb-4">Preview</div>
          <div className="rounded-xl bg-[#0d0d10] p-5 flex items-center gap-3">
            {logoUrl ? (
              <img
                src={`/api/storage${logoUrl}`}
                alt="Dealership logo"
                className="h-9 w-9 shrink-0 rounded-xl object-contain bg-white/5 ring-1 ring-white/10"
              />
            ) : (
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/20 ring-1 ring-primary/30">
                <Sparkles className="h-5 w-5 text-gold" />
              </span>
            )}
            <div className="flex flex-col leading-none overflow-hidden">
              <span className="text-lg font-bold tracking-tight text-white truncate">
                {previewName}
              </span>
              <span className="mt-1 text-[9px] font-medium uppercase tracking-[0.22em] text-white/40">
                Dealership OS
              </span>
            </div>
          </div>
          <p className="text-xs text-muted-foreground mt-4">
            This identity also replaces the AURA header on printed invoices,
            quotations, receipts and handover forms.
          </p>
        </div>
      </div>
    </Page>
  );
}
