import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetCurrentUser,
  useUpdateMyProfile,
  getGetCurrentUserQueryKey,
} from "@workspace/api-client-react";
import { Page } from "@/components/layout/page";
import { PageHero } from "@/components/layout/page-hero";
import { SettingsTabs } from "@/components/settings-nav";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { Loader2, UserCircle } from "lucide-react";

/**
 * Self-service profile: every signed-in user can update their own basic
 * info (display name, phone). Email and photo come from the sign-in
 * account (Clerk) and are shown read-only here.
 */
export default function SettingsProfile() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: me, isLoading } = useGetCurrentUser();

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  // Hydrate once per loaded user so an in-flight edit isn't clobbered by
  // background refetches of /auth/me.
  const hydratedFor = useRef<number | null>(null);
  useEffect(() => {
    if (me && hydratedFor.current !== me.id) {
      hydratedFor.current = me.id;
      setName(me.name ?? "");
      setPhone(me.phone ?? "");
    }
  }, [me]);

  const update = useUpdateMyProfile();

  const dirty =
    !!me &&
    (name.trim() !== (me.name ?? "") || phone.trim() !== (me.phone ?? ""));

  const save = async () => {
    if (!name.trim()) {
      toast({
        title: "Name required",
        description: "Your display name cannot be blank.",
        variant: "destructive",
      });
      return;
    }
    try {
      const saved = await update.mutateAsync({
        data: { name: name.trim(), phone: phone.trim() || null },
      });
      // Reflect the server's canonical (trimmed/normalized) values so the
      // form isn't left falsely dirty after a successful save.
      setName(saved.name ?? "");
      setPhone(saved.phone ?? "");
      await qc.invalidateQueries({ queryKey: getGetCurrentUserQueryKey() });
      toast({ title: "Profile updated" });
    } catch {
      toast({
        title: "Could not save profile",
        description: "Please try again.",
        variant: "destructive",
      });
    }
  };

  return (
    <Page>
      <PageHero
        title="Profile"
        subtitle="Your personal details, shown to teammates across the app."
        icon={UserCircle}
      />
      <SettingsTabs />
      <div className="px-5 md:px-8 pb-10 max-w-xl">
        {isLoading || !me ? (
          <div className="flex items-center gap-2 text-muted-foreground text-sm py-8">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading profile…
          </div>
        ) : (
          <div className="rounded-2xl border border-border bg-card p-6 space-y-5">
            <div className="flex items-center gap-4">
              {me.imageUrl ? (
                <img
                  src={me.imageUrl}
                  alt={me.name ?? "Profile photo"}
                  className="w-14 h-14 rounded-full object-cover border border-border"
                />
              ) : (
                <div className="w-14 h-14 rounded-full bg-foreground/[0.06] flex items-center justify-center">
                  <UserCircle className="w-8 h-8 text-muted-foreground/50" />
                </div>
              )}
              <div className="min-w-0">
                <div className="font-semibold truncate">
                  {me.name ?? me.email ?? "—"}
                </div>
                <div className="text-xs text-muted-foreground truncate">
                  {me.roleName ?? "No role"}
                </div>
              </div>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                Display name
              </label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={120}
                placeholder="Your name"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                Phone
              </label>
              <Input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                maxLength={32}
                placeholder="+592 …"
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                Email
              </label>
              <Input value={me.email ?? ""} disabled />
              <p className="text-[11px] text-muted-foreground">
                Email and profile photo come from your sign-in account and
                can't be changed here.
              </p>
            </div>

            <div className="pt-1">
              <Button onClick={save} disabled={!dirty || update.isPending}>
                {update.isPending && (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                )}
                Save changes
              </Button>
            </div>
          </div>
        )}
      </div>
    </Page>
  );
}
