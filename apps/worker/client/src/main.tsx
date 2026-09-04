import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import { App } from "./App";
import { getPasscode, setPasscode } from "./api";
import { startUpdateCheck } from "./update-check";
import "./styles.css";

// Keep SW able to read passcode for notification "Done" actions.
setPasscode(getPasscode());

navigator.serviceWorker?.addEventListener("message", (event) => {
  if (
    event.data?.type === "GET_PASSCODE" &&
    event.ports?.[0]
  ) {
    event.ports[0].postMessage({ passcode: getPasscode() || null });
  }
});

const UPDATE_CHECK_MS = 15 * 60_000;

// A long-lived PWA may go days without a navigation, and a new worker is only
// noticed when something asks. Poll for one, and again whenever the app is
// brought back to the foreground.
registerSW({
  immediate: true,
  onRegisteredSW(_swUrl, registration) {
    if (!registration) return;
    const check = () => void registration.update();
    setInterval(check, UPDATE_CHECK_MS);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) check();
    });
  },
});

// clientsClaim hands the page to the new worker, but the JS already parsed in
// this tab is still the old build, so reload once it takes over. Guarded on a
// pre-existing controller, since first-ever install also fires this.
if (navigator.serviceWorker?.controller) {
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
}

startUpdateCheck();

function Root() {
  useEffect(() => {
    // noop mount hook for future install prompt
  }, []);

  return <App />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
