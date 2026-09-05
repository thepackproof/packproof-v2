import { SafeAreaProvider } from "react-native-safe-area-context";
import { PackProofProvider } from "./src/app/PackProofProvider";
import { Root } from "./src/app/Root";
import { ThemeProvider } from "./src/theme/ThemeProvider";
import { CameraSpikeScreen } from "./src/screens/CameraSpikeScreen";

export default function App() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        {process.env.EXPO_PUBLIC_PACKPROOF_CAMERA_SPIKE === "true" ? <CameraSpikeScreen /> : <PackProofProvider>
          <Root />
        </PackProofProvider>}
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
