import { Button } from "@/components/ui/button";
import { useSystemTheme } from "./theme";

export default function App() {
  useSystemTheme();
  return (
    <div data-testid="app-root" className="p-4">
      <span>delta</span>
      <Button className="ml-2">OK</Button>
    </div>
  );
}
