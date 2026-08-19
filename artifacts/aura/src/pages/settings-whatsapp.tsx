import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  useGetWhatsappSettings,
  useUpdateWhatsappSettings,
  useTestWhatsappConnection,
  getGetWhatsappSettingsQueryKey,
} from "@workspace/api-client-react";
import { PageHero } from "@/components/layout/page-hero";
import { SettingsTabs } from "@/components/settings-nav";
import { Page } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { useToast } from "@/hooks/use-toast";
import { useAuthz } from "@/lib/auth";
import { cn } from "@/lib/utils";
import {
  MessageSquare,
  Loader2,
  CheckCircle2,
  XCircle,
  Copy,
  KeyRound,
  BookOpen,
  Smartphone,
  ShieldCheck,
} from "lucide-react";

const formSchema = z.object({
  wabaId: z
    .string()
    .min(5, "WABA ID is required")
    .max(64)
    .regex(/^\d+$/, "Use the numeric WABA ID from Meta"),
  phoneNumberId: z
    .string()
    .min(5, "Phone Number ID is required")
    .max(64)
    .regex(/^\d+$/, "Use the numeric Phone Number ID from Meta"),
  accessToken: z.string().optional(),
  serviceTemplateName: z
    .string()
    .regex(/^[a-z0-9_]*$/, "Use lowercase letters, numbers, and underscores only")
    .optional(),
  serviceTemplateLanguage: z
    .string()
    .regex(
      /^[A-Za-z]{2,3}(?:_[A-Za-z]{2})?$/,
      "Use a Meta language code such as en_US",
    ),
});

function saveErrorMessage(error: unknown): string {
  const apiError = error as {
    response?: { data?: { error?: unknown } };
    data?: { error?: unknown };
  };
  const message = apiError.response?.data?.error ?? apiError.data?.error;
  if (typeof message === "string" && message.trim()) return message;
  return error instanceof Error
    ? error.message
    : "Unable to save the WhatsApp settings. Please try again.";
}

export default function SettingsWhatsapp() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { activeDealer, me } = useAuthz();
  
  const isGm =
    !!activeDealer?.isGeneralManager ||
    activeDealer?.roleName === "General Manager" ||
    !!me?.isSuperAdmin;

  const { data: settings, isLoading } = useGetWhatsappSettings();

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      wabaId: "",
      phoneNumberId: "",
      accessToken: "",
      serviceTemplateName: "",
      serviceTemplateLanguage: "en_US",
    },
  });

  useEffect(() => {
    if (settings) {
      form.reset({
        wabaId: settings.wabaId ?? "",
        phoneNumberId: settings.phoneNumberId ?? "",
        accessToken: "",
        serviceTemplateName: settings.serviceTemplateName ?? "",
        serviceTemplateLanguage: settings.serviceTemplateLanguage ?? "en_US",
      });
    }
  }, [settings, form]);

  const refreshSettings = () =>
    qc.invalidateQueries({ queryKey: getGetWhatsappSettingsQueryKey() });

  const save = useUpdateWhatsappSettings({
    mutation: {
      onSuccess: () => {
        toast({ title: "WhatsApp connection saved" });
        form.setValue("accessToken", "");
        refreshSettings();
      },
      onError: (e) =>
        toast({
          title: "Could not save",
          description: saveErrorMessage(e),
          variant: "destructive",
        }),
    },
  });

  const test = useTestWhatsappConnection({
    mutation: {
      onSuccess: (res) => {
        if (res.ok) {
          toast({
            title: "Connected to Meta WhatsApp",
            description: `Verified as ${res.verifiedName ?? "Unknown"} (${res.displayPhoneNumber ?? "Unknown Number"}).`,
          });
        } else {
          toast({
            title: "Connection failed",
            description: res.error ?? "Failed to connect",
            variant: "destructive",
          });
        }
        refreshSettings();
      },
      onError: (e) =>
        toast({
          title: "Test failed",
          description: e instanceof Error ? e.message : String(e),
          variant: "destructive",
        }),
    },
  });

  function onSubmit(values: z.infer<typeof formSchema>) {
    if (!settings?.hasAccessToken && !values.accessToken?.trim()) {
      form.setError("accessToken", {
        type: "required",
        message: "A permanent System User access token is required",
      });
      return;
    }
    save.mutate({
      data: {
        wabaId: values.wabaId.trim(),
        phoneNumberId: values.phoneNumberId.trim(),
        accessToken: values.accessToken?.trim() || undefined,
        serviceTemplateName: values.serviceTemplateName?.trim() || null,
        serviceTemplateLanguage:
          values.serviceTemplateLanguage?.trim() || "en_US",
      },
    });
  }

  const configured = settings?.configured ?? false;
  const connected = settings?.lastStatus === "connected";

  const webhookUrl = `${window.location.origin}${import.meta.env.BASE_URL}api/webhooks/whatsapp`;

  const copy = (value: string, label: string) => {
    void navigator.clipboard.writeText(value);
    toast({ title: `${label} copied` });
  };

  return (
    <>
      <PageHero
        eyebrow="Settings"
        icon={MessageSquare}
        title="WhatsApp"
        accent="Integration"
        subtitle="Connect your Meta WhatsApp Business account to message leads and customers directly."
      />
      <SettingsTabs />
      <Page className="space-y-5 pt-0">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {/* Status Panel */}
          <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 space-y-4">
            <div className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">
              Connection status
            </div>
            {isLoading ? (
              <Loader2 className="h-6 w-6 animate-spin text-primary" data-testid="status-loading" />
            ) : (
              <div className="flex items-start gap-3">
                {connected ? (
                  <CheckCircle2 className="h-8 w-8 text-emerald-400 mt-0.5" data-testid="status-icon-connected" />
                ) : (
                  <XCircle className={cn("h-8 w-8 mt-0.5", configured ? "text-amber-400" : "text-red-400")} data-testid="status-icon-disconnected" />
                )}
                <div>
                  <div className="font-semibold" data-testid="status-text-title">
                    {connected
                      ? `Connected — ${settings?.verifiedName ?? settings?.displayPhoneNumber ?? "Verified"}`
                      : configured
                        ? settings?.lastStatus === "error"
                          ? "Connection error"
                          : "Configured — not yet verified"
                        : "Not connected"}
                  </div>
                  <div className="text-xs text-muted-foreground mt-1" data-testid="status-text-subtitle">
                    {connected
                      ? `Cloud API status: Active · last checked ${settings?.lastCheckedAt ? new Date(settings.lastCheckedAt).toLocaleString() : "—"}`
                      : configured
                        ? settings?.lastError ?? "Run “Test connection” to verify the credentials and subscribe the app."
                        : "Enter your WABA ID, Phone Number ID, and token to connect."}
                  </div>
                </div>
              </div>
            )}
            {configured && (
              <div className="flex items-center gap-3 pt-2">
                <Button
                  variant="outline"
                  onClick={() => test.mutate()}
                  disabled={test.isPending || !isGm}
                  className="gap-2"
                  data-testid="button-test-connection"
                >
                  {test.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <MessageSquare className="h-4 w-4" />
                  )}
                  Test connection
                </Button>
                <button
                  onClick={() =>
                    save.mutate({ data: { enabled: !settings?.enabled } })
                  }
                  disabled={save.isPending || !isGm}
                  className="text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                  data-testid="button-toggle-sync"
                >
                  {settings?.enabled ? "Pause channel" : "Resume channel"}
                </button>
                {!settings?.enabled && (
                  <Badge variant="outline" className="border-amber-500/40 text-amber-400 text-[10px] uppercase" data-testid="badge-sync-paused">
                    Channel paused
                  </Badge>
                )}
              </div>
            )}
          </div>

          {/* Credentials Form Panel */}
          <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 space-y-3">
            <div className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">
              Credentials
            </div>
            {!isGm && (
              <p className="text-xs text-amber-400/90" data-testid="text-gm-restriction">
                Only the general manager can change the WhatsApp connection.
              </p>
            )}
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                <FormField
                  control={form.control}
                  name="wabaId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>WhatsApp Business Account ID</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="e.g. 102345678901234"
                          autoComplete="off"
                          disabled={!isGm}
                          data-testid="input-waba-id"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="phoneNumberId"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Phone Number ID</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="e.g. 109876543210987"
                          autoComplete="off"
                          disabled={!isGm}
                          data-testid="input-phone-number-id"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="accessToken"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>System User Access Token</FormLabel>
                      <FormControl>
                        <Input
                          type="password"
                          autoComplete="new-password"
                          placeholder={
                            settings?.hasAccessToken
                              ? "Saved — leave blank to keep existing token"
                              : "EAABw..."
                          }
                          disabled={!isGm}
                          data-testid="input-access-token"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="serviceTemplateName"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Approved service template</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="customer_service_update"
                          autoComplete="off"
                          disabled={!isGm}
                          data-testid="input-service-template-name"
                          {...field}
                        />
                      </FormControl>
                      <FormDescription>
                        Used only when Meta's 24-hour reply window is closed.
                        The approved template must contain exactly one text body
                        variable for AURA's message.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="serviceTemplateLanguage"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Template language</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="en_US"
                          autoComplete="off"
                          disabled={!isGm}
                          data-testid="input-service-template-language"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <Button
                  type="submit"
                  disabled={!isGm || save.isPending}
                  className="gap-2"
                  data-testid="button-submit-whatsapp-credentials"
                >
                  {save.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <KeyRound className="h-4 w-4" />
                  )}
                  {settings?.configured ? "Update connection" : "Connect"}
                </Button>
                <p className="text-[11px] text-muted-foreground">
                  Credentials are stored server-side encrypted. The access token is never shown again after saving.
                </p>
              </form>
            </Form>
          </div>
        </div>

        {/* Webhook Panel */}
        <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 space-y-4">
          <div className="text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">
            Inbound webhook (Meta → AURA)
          </div>
          <div className="space-y-1.5">
            <div className="text-[11px] font-semibold text-muted-foreground">Callback URL</div>
            <div className="flex items-center gap-2 max-w-xl">
              <code className="text-xs bg-black/30 border border-white/10 rounded-lg px-3 py-2 truncate flex-1" data-testid="text-webhook-url">
                {webhookUrl}
              </code>
              <Button variant="outline" size="icon" onClick={() => copy(webhookUrl, "Webhook URL")} data-testid="button-copy-webhook-url">
                <Copy className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            The Webhook verify token is managed centrally by the platform. You do not need to enter it here.
          </p>
        </div>

        {/* Setup Instructions Panel */}
        <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 space-y-4">
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-muted-foreground">
            <BookOpen className="h-3.5 w-3.5" /> Meta Setup Instructions
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs text-muted-foreground">
            <div className="rounded-xl border border-white/10 bg-foreground/[0.03] p-4 space-y-1.5">
              <div className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                <Smartphone className="h-4 w-4 text-primary" /> 1. Assign Assets
              </div>
              <p>
                In the shared AURA DMS Meta App, assign your dealership's WhatsApp Business Account (WABA) and phone number.
              </p>
            </div>
            <div className="rounded-xl border border-white/10 bg-foreground/[0.03] p-4 space-y-1.5">
              <div className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                <KeyRound className="h-4 w-4 text-primary" /> 2. Generate Token
              </div>
              <p>
                Create a permanent System User token with the <code className="text-foreground">whatsapp_business_messaging</code> and <code className="text-foreground">whatsapp_business_management</code> permissions.
              </p>
            </div>
            <div className="rounded-xl border border-white/10 bg-foreground/[0.03] p-4 space-y-1.5">
              <div className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                <ShieldCheck className="h-4 w-4 text-primary" /> 3. Test Connection
              </div>
              <p>
                Enter the WABA ID, Phone Number ID, and token here. Save, then run "Test connection" to verify identity, Cloud API status, and subscribe the app to messages.
              </p>
            </div>
          </div>
          <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 text-amber-500/90 text-xs">
            <strong className="font-semibold text-amber-400">Note:</strong> Meta enforces a 24-hour window for free-form replies after a user messages you. Unverified test numbers are restricted to 5 pre-verified recipient numbers.
          </div>
        </div>
      </Page>
    </>
  );
}
