import { notFound } from "next/navigation";

import { DurableMeetingPreparation } from "../../src/components/durable-meeting-preparation";

export default function MeetingPreparationPage() {
  // The durable backend is now real, but this standalone review route still uses
  // the development access-token bridge. Production exposure belongs inside the
  // authenticated workspace shell rather than bypassing Entra session handling.
  if (process.env.NODE_ENV === "production") notFound();

  return <DurableMeetingPreparation />;
}
