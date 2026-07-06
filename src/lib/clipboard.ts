import { isTauri } from "@tauri-apps/api/core";

export async function copyText(text: string) {
  if (isTauri()) {
    const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
    await writeText(text);
    return;
  }

  await navigator.clipboard.writeText(text);
}
