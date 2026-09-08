"use client";

import { broadcastResponseToMainFrame } from "@azure/msal-browser/redirect-bridge";
import { useEffect, useState } from "react";

export default function EntraRedirectBridgePage() {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    void broadcastResponseToMainFrame().catch((error: unknown) => {
      console.error("Failed to process Microsoft Entra redirect response", error);
      setFailed(true);
    });
  }, []);

  return (
    <main className="grid min-h-screen place-items-center px-4 py-10">
      <p className="text-sm text-[#aab5c5]" role={failed ? "alert" : undefined}>
        {failed
          ? "Sign-in response could not be processed. Return to Atoms and try again."
          : "Completing secure sign-in…"}
      </p>
    </main>
  );
}
