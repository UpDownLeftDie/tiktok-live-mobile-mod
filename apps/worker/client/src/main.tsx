import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import { App } from "./App";
import { getPasscode, setPasscode } from "./api";
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

registerSW({ immediate: true });

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
