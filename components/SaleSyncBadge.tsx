"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Clock3, RefreshCw } from "lucide-react";
import api from "@/service/api";
import { useLanguage } from "@/context/LanguageContext";

/**
 * ອັບເດດຫຼ້າສຸດ · ນັບຖອຍຫຼັງຮອບຕໍ່ໄປ.
 *
 * The sale figures are a copy of the ERP that a cron reloads at twenty past
 * every hour, so a reader looking at a number needs two things the page never
 * said: when it was last true, and how long before it moves again.
 *
 * The clock is the SERVER's. The API hands over a number of seconds and this
 * counts them down locally, so a workstation whose own date is a day out — this
 * office has one — still reads the right countdown.
 *
 * When it reaches zero the reload is running: the badge says so, then asks
 * again once the run has had time to finish and calls `onUpdated` so the page
 * it sits in can fetch its own numbers afresh.
 */
type Sync = {
  last_update: string | null;
  next_update: string | null;
  seconds_to_next: number;
  data_through: string | null;
  server_date: string | null;
  run_seconds: number;
};

const mmss = (seconds: number) => {
  const safe = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
};

/** 'YYYY-MM-DD HH:MM' → 'HH:MM' today, 'DD-MM HH:MM' on an older day. */
const shortTime = (value: string | null, today: string | null) => {
  if (!value) return "–";
  const [day, time] = value.split(" ");
  if (!time) return value;
  if (today && day === today) return time;
  const [, month, date] = day.split("-");
  return `${date}-${month} ${time}`;
};

export default function SaleSyncBadge({ onUpdated }: { onUpdated?: () => void }) {
  const { t } = useLanguage();
  const [sync, setSync] = useState<Sync | null>(null);
  const [left, setLeft] = useState(0);
  const lastSeen = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.get("/system/sale-sync");
      if (!res.data?.success) return;
      const next: Sync = res.data.data;
      setSync(next);
      setLeft(next.seconds_to_next);
      // A run that has landed since the page was drawn is worth telling the
      // page about — its own figures are one request away from being current.
      if (lastSeen.current && next.last_update && next.last_update !== lastSeen.current) {
        onUpdated?.();
      }
      lastSeen.current = next.last_update;
    } catch {
      /* leave the last reading standing */
    }
  }, [onUpdated]);

  // Off a timer rather than straight out of the effect body: the first reading
  // is a fetch like any other, not part of this render.
  useEffect(() => {
    const timer = setTimeout(load, 0);
    return () => clearTimeout(timer);
  }, [load]);

  // One tick a second, and a fresh reading when the countdown runs out — plus
  // the run's own duration, so the answer includes the run that just happened.
  useEffect(() => {
    const timer = setInterval(() => {
      setLeft((value) => {
        if (value > 0) return value - 1;
        return value;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (left > 0 || !sync) return;
    const timer = setTimeout(load, (sync.run_seconds || 45) * 1000);
    return () => clearTimeout(timer);
  }, [left, sync, load]);

  if (!sync) return null;

  const running = left <= 0;
  const today = sync.server_date;

  return (
    <span
      className="pill pill-muted"
      title={`${t("sync.last")} ${sync.last_update ?? "–"} · ${t("sync.next")} ${sync.next_update ?? "–"}`}
    >
      {running ? (
        <>
          <RefreshCw size={10} className="animate-spin" /> {t("sync.running")}
        </>
      ) : (
        <>
          <Clock3 size={10} /> {t("sync.last")} {shortTime(sync.last_update, today)} ·{" "}
          {t("sync.next")} {sync.next_update} ({mmss(left)})
        </>
      )}
    </span>
  );
}
