import { useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useQueryClient } from "@tanstack/react-query";
import {
  CalendarClock,
  CircleCheck,
  Loader2,
  MapPin,
  TriangleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  useGetTestDriveInvite,
  useBookTestDriveSlot,
  getGetTestDriveInviteQueryKey,
} from "@workspace/api-client-react";

function errorStatus(err: unknown): number | null {
  if (err && typeof err === "object" && "status" in err) {
    const s = (err as { status: unknown }).status;
    if (typeof s === "number") return s;
  }
  return null;
}

export default function BookTestDrive({
  params,
}: {
  params: { token: string };
}) {
  const token = params.token;
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useGetTestDriveInvite(token);
  const book = useBookTestDriveSlot();

  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);
  const [rescheduling, setRescheduling] = useState(false);
  const [bookError, setBookError] = useState<string | null>(null);
  const [justBooked, setJustBooked] = useState(false);

  const days = data?.days ?? [];
  const activeDay = useMemo(
    () =>
      days.find((d) => d.date === selectedDay) ??
      days.find((d) => d.slots.some((s) => s.available)) ??
      days[0],
    [days, selectedDay],
  );

  const confirm = async () => {
    if (!selectedSlot) return;
    setBookError(null);
    try {
      const refreshed = await book.mutateAsync({
        token,
        data: { slot: selectedSlot },
      });
      queryClient.setQueryData(getGetTestDriveInviteQueryKey(token), refreshed);
      setSelectedSlot(null);
      setRescheduling(false);
      setJustBooked(true);
    } catch (err) {
      const status = errorStatus(err);
      if (status === 409) {
        setBookError(
          "That time was just taken — please choose another slot.",
        );
        setSelectedSlot(null);
        void queryClient.invalidateQueries({
          queryKey: getGetTestDriveInviteQueryKey(token),
        });
      } else if (status === 404) {
        setBookError("This booking link is no longer valid.");
      } else {
        setBookError("Something went wrong — please try again.");
      }
    }
  };

  const invalidLink = errorStatus(error) === 404;

  return (
    <div className="dark min-h-screen bg-[hsl(0,0%,5%)] text-white relative overflow-hidden">
      <div
        className="pointer-events-none absolute inset-0"
        aria-hidden
        style={{
          background:
            "radial-gradient(ellipse 80% 50% at 50% -10%, hsla(0,82%,44%,0.18), transparent 70%)",
        }}
      />

      <header className="relative z-10 flex items-center justify-center py-8">
        <div className="text-center">
          <div className="text-2xl font-light tracking-[0.35em]">
            AURA<span className="text-primary">.</span>OS
          </div>
          <div className="text-[10px] uppercase tracking-[0.4em] text-white/40 mt-1">
            Private test drive
          </div>
        </div>
      </header>

      <main className="relative z-10 mx-auto w-full max-w-2xl px-4 pb-16">
        {isLoading ? (
          <div className="flex flex-col items-center gap-3 py-24 text-white/60">
            <Loader2 className="w-6 h-6 animate-spin" />
            <span className="text-sm">Preparing your invitation…</span>
          </div>
        ) : invalidLink || !data ? (
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-10 text-center space-y-3">
            <TriangleAlert className="w-10 h-10 text-primary mx-auto" />
            <h1 className="text-xl font-light">
              This booking link isn't valid
            </h1>
            <p className="text-sm text-white/50 max-w-sm mx-auto leading-relaxed">
              The link may have been mistyped or replaced. Please use the most
              recent invitation email, or contact your AURA advisor.
            </p>
          </div>
        ) : (
          <div className="space-y-6">
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] overflow-hidden">
              {data.vehicleImageUrl && (
                <div className="relative h-52 sm:h-64">
                  <img
                    src={data.vehicleImageUrl}
                    alt={data.vehicle ?? "Vehicle"}
                    className="absolute inset-0 w-full h-full object-cover"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-[hsl(0,0%,5%)] via-[hsla(0,0%,5%,0.35)] to-transparent" />
                </div>
              )}
              <div className="p-6 sm:p-8 space-y-2">
                <p className="text-[11px] uppercase tracking-[0.3em] text-primary">
                  Reserved for {data.leadName}
                </p>
                <h1 className="text-2xl sm:text-3xl font-light tracking-tight">
                  {data.vehicle ?? "Your private test drive"}
                </h1>
                <p className="text-sm text-white/50 flex items-center gap-1.5">
                  <MapPin className="w-3.5 h-3.5" />
                  {data.branch ?? "Main Showroom"}
                </p>
              </div>
            </div>

            <AnimatePresence mode="wait">
              {data.bookedAt && !rescheduling ? (
                <motion.div
                  key="confirmed"
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  className="rounded-2xl border border-white/10 bg-white/[0.03] p-8 text-center space-y-4"
                >
                  <CircleCheck className="w-12 h-12 text-primary mx-auto" />
                  <div className="space-y-1">
                    <h2 className="text-xl font-light">
                      {justBooked
                        ? "Your time is blocked"
                        : "Your test drive is scheduled"}
                    </h2>
                    <p className="text-sm text-white/60">
                      {data.bookedLabel}
                    </p>
                    <p className="text-xs text-white/40">
                      {data.branch ?? "Main Showroom"} — the vehicle will be
                      detailed and waiting for you.
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    className="rounded-full border-white/20 bg-transparent text-white hover:bg-white/10 hover:text-white"
                    onClick={() => {
                      setJustBooked(false);
                      setRescheduling(true);
                    }}
                  >
                    Choose a different time
                  </Button>
                </motion.div>
              ) : (
                <motion.div
                  key="picker"
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  className="rounded-2xl border border-white/10 bg-white/[0.03] p-6 sm:p-8 space-y-6"
                >
                  <div className="flex items-center gap-2 text-sm text-white/70">
                    <CalendarClock className="w-4 h-4 text-primary" />
                    Choose a day and time — the slot is blocked exclusively for
                    you.
                  </div>

                  <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
                    {days.map((day) => {
                      const open = day.slots.filter((s) => s.available).length;
                      const active = day.date === activeDay?.date;
                      return (
                        <button
                          key={day.date}
                          type="button"
                          onClick={() => {
                            setSelectedDay(day.date);
                            setSelectedSlot(null);
                          }}
                          className={`shrink-0 rounded-xl border px-4 py-2.5 text-left transition-colors ${
                            active
                              ? "border-primary/60 bg-primary/15"
                              : "border-white/10 bg-white/[0.02] hover:bg-white/[0.06]"
                          }`}
                        >
                          <div className="text-sm font-medium whitespace-nowrap">
                            {day.label}
                          </div>
                          <div
                            className={`text-[11px] ${open ? "text-white/40" : "text-primary/70"}`}
                          >
                            {open ? `${open} open` : "Fully booked"}
                          </div>
                        </button>
                      );
                    })}
                  </div>

                  {activeDay && (
                    <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                      {activeDay.slots.map((slot) => {
                        const selected = selectedSlot === slot.iso;
                        return (
                          <button
                            key={slot.iso}
                            type="button"
                            disabled={!slot.available}
                            onClick={() =>
                              setSelectedSlot(selected ? null : slot.iso)
                            }
                            className={`rounded-lg border px-3 py-2.5 text-sm transition-colors ${
                              !slot.available
                                ? "border-white/5 bg-white/[0.01] text-white/25 line-through cursor-not-allowed"
                                : selected
                                  ? "border-primary bg-primary text-white"
                                  : "border-white/10 bg-white/[0.03] hover:bg-white/[0.08]"
                            }`}
                          >
                            {slot.label}
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {bookError && (
                    <p className="text-sm text-primary flex items-center gap-1.5">
                      <TriangleAlert className="w-4 h-4 shrink-0" />
                      {bookError}
                    </p>
                  )}

                  <div className="flex items-center gap-3">
                    <Button
                      className="rounded-full px-8"
                      disabled={!selectedSlot || book.isPending}
                      onClick={confirm}
                    >
                      {book.isPending ? (
                        <>
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          Blocking your slot…
                        </>
                      ) : (
                        "Block this time"
                      )}
                    </Button>
                    {rescheduling && (
                      <Button
                        variant="ghost"
                        className="rounded-full text-white/60 hover:text-white hover:bg-white/10"
                        onClick={() => {
                          setRescheduling(false);
                          setSelectedSlot(null);
                          setBookError(null);
                        }}
                      >
                        Keep my current time
                      </Button>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            <p className="text-center text-[11px] text-white/30 leading-relaxed">
              AURA Dealership — Premium Automotive Concierge.
              <br />
              Need help? Reply to your invitation email and an advisor will
              assist you.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
