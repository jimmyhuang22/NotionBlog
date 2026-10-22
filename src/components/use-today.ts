"use client";

import { useMemo, useSyncExternalStore } from "react";
import { calendarDay, type CalendarDay } from "../lib/format.ts";

const key = (day: CalendarDay | null) => day ? `${day.year}-${day.month}-${day.day}` : "";

/** Wake-ups that can mean the day has changed: the page is shown again, or a minute has passed. */
function subscribe(changed: () => void): () => void {
  const timer = window.setInterval(changed, 60_000);
  document.addEventListener("visibilitychange", changed);
  window.addEventListener("pageshow", changed);
  return () => {
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", changed);
    window.removeEventListener("pageshow", changed);
  };
}

/**
 * Today's calendar day in the site's time zone, by this device's clock. Pages are kept as cached markup
 * for up to a day, so the server's moment says nothing about today: the markup, and the first render
 * here that takes it over, know no day at all (null), and dates are written out in full. The device's
 * day follows at once, and a page left open past midnight, or shown again the next morning, stops
 * calling yesterday "今天". Only a change of day re-renders anything.
 */
export function useToday(timeZone: string): CalendarDay | null {
  const day = useSyncExternalStore(subscribe, () => key(calendarDay(new Date().toISOString(), timeZone)), () => "");
  return useMemo(() => {
    const [year, month, date] = day.split("-").map(Number);
    return day ? { year: year!, month: month!, day: date! } : null;
  }, [day]);
}
