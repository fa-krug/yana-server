import * as React from "react";

const MOBILE_BREAKPOINT = 768;

// useSyncExternalStore (rather than useState+useEffect) subscribes to the
// matchMedia change event without ever calling setState synchronously inside
// an effect body -- which is what shadcn's original generated hook did and
// what trips the react-hooks/set-state-in-effect lint rule. getServerSnapshot
// mirrors the old "undefined -> false" default so SSR and the first client
// render still agree.
function subscribe(callback: () => void) {
  const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
  mql.addEventListener("change", callback);
  return () => mql.removeEventListener("change", callback);
}

function getSnapshot() {
  return window.innerWidth < MOBILE_BREAKPOINT;
}

function getServerSnapshot() {
  return false;
}

export function useIsMobile() {
  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
