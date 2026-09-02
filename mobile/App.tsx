import { SafeAreaProvider } from "react-native-safe-area-context";
import { PackProofProvider } from "./src/app/PackProofProvider";
import { Root } from "./src/app/Root";
import { ThemeProvider } from "./src/theme/ThemeProvider";

export default function App() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <PackProofProvider>
          <Root />
        </PackProofProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
