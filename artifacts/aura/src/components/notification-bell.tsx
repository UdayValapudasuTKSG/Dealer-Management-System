import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { motion, AnimatePresence } from "framer-motion";
import { Bell, CheckCheck, ClipboardList, Mail, ShieldAlert, UserPlus, Info } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListNotifications,
  useMarkNotificationsRead,
  getListNotificationsQueryKey,
  type Notification,
} from "@workspace/api-client-react";
import { cn } from "@/lib/utils";

const TYPE_ICON: Record<Notification["type"], typeof Bell> = {
  approval: ShieldAlert,
  assignment: UserPlus,
  task: ClipboardList,
  email: Mail,
  system: Info,
};

function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - +new Date(iso)) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const { data: notifications } = useListNotifications({
    query: {
      queryKey: getListNotificationsQueryKey(),
      refetchInterval: 30_000,
      refetchOnWindowFocus: true,
      staleTime: 15_000,
    },
  });

  const markRead = useMarkNotificationsRead({
    mutation: {
      onSuccess: () =>
        qc.invalidateQueries({ queryKey: getListNotificationsQueryKey() }),
    },
  });

  const unread = (notifications ?? []).filter((n) => !n.read);

  // Browser notifications for newly arrived items.
  const seenMaxId = useRef<number | null>(null);
  useEffect(() => {
    if (!notifications || notifications.length === 0) return;
    const maxId = Math.max(...notifications.map((n) => n.id));
    if (seenMaxId.current === null) {
      seenMaxId.current = maxId;
      return;
    }
    if (maxId > seenMaxId.current) {
      const fresh = notifications.filter(
        (n) => n.id > (seenMaxId.current ?? 0) && !n.read,
      );
      seenMaxId.current = maxId;
      if (
        typeof window !== "undefined" &&
        "Notification" in window &&
        window.Notification.permission === "granted"
      ) {
        for (const n of fresh.slice(0, 3)) {
          try {
            new window.Notification(n.title, { body: n.body ?? undefined });
          } catch {
            // some browsers restrict constructor use; ignore
          }
        }
      }
    }
  }, [notifications]);

  const requestPermissionIfNeeded = () => {
    if (
      typeof window !== "undefined" &&
      "Notification" in window &&
      window.Notification.permission === "default"
    ) {
      void window.Notification.requestPermission();
    }
  };

  const openItem = (n: Notification) => {
    if (!n.read) markRead.mutate({ data: { ids: [n.id] } });
    setOpen(false);
    if (n.link) navigate(n.link);
  };

  return (
    <div className="relative">
      <button
        onClick={() => {
          setOpen((v) => !v);
          requestPermissionIfNeeded();
        }}
        aria-label="Notifications"
        className="relative h-10 w-10 rounded-full border border-white/10 bg-foreground/[0.04] hover:bg-foreground/[0.08] flex items-center justify-center transition-colors"
      >
        <Bell className="h-[18px] w-[18px] text-muted-foreground" />
        {unread.length > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-primary text-white text-[10px] font-bold flex items-center justify-center shadow-lg shadow-primary/40">
            {unread.length > 99 ? "99+" : unread.length}
          </span>
        )}
      </button>
      <AnimatePresence>
        {open && (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
            <motion.div
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.15 }}
              className="absolute right-0 top-full z-50 mt-2 w-[380px] max-w-[90vw] rounded-xl border border-white/10 bg-popover shadow-2xl overflow-hidden"
            >
              <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06]">
                <div className="text-sm font-semibold">Notifications</div>
                {unread.length > 0 && (
                  <button
                    onClick={() => markRead.mutate({ data: { all: true } })}
                    className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <CheckCheck className="h-3.5 w-3.5" /> Mark all read
                  </button>
                )}
              </div>
              <div className="max-h-[420px] overflow-y-auto">
                {(notifications ?? []).length === 0 ? (
                  <div className="px-4 py-10 text-center text-sm text-muted-foreground">
                    You're all caught up.
                  </div>
                ) : (
                  (notifications ?? []).map((n) => {
                    const Icon = TYPE_ICON[n.type] ?? Info;
                    return (
                      <button
                        key={n.id}
                        onClick={() => openItem(n)}
                        className={cn(
                          "w-full flex items-start gap-3 px-4 py-3 text-left border-b border-white/[0.04] transition-colors hover:bg-foreground/[0.04]",
                          !n.read && "bg-primary/[0.05]",
                        )}
                      >
                        <span
                          className={cn(
                            "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
                            n.read
                              ? "bg-foreground/[0.05] text-muted-foreground"
                              : "bg-primary/15 text-primary",
                          )}
                        >
                          <Icon className="h-4 w-4" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span
                            className={cn(
                              "block text-sm leading-snug",
                              n.read
                                ? "text-muted-foreground"
                                : "font-medium text-foreground",
                            )}
                          >
                            {n.title}
                          </span>
                          {n.body && (
                            <span className="mt-0.5 block text-xs text-muted-foreground line-clamp-2">
                              {n.body}
                            </span>
                          )}
                          <span className="mt-1 block text-[10px] uppercase tracking-wider text-muted-foreground/60">
                            {timeAgo(n.createdAt)}
                          </span>
                        </span>
                        {!n.read && (
                          <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" />
                        )}
                      </button>
                    );
                  })
                )}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
