import { SafeAreaProvider } from "react-native-safe-area-context";
import { PackProofProvider } from "./src/app/PackProofProvider";
import { Root } from "./src/app/Root";

export default function App() {
  return (
    <SafeAreaProvider>
      <PackProofProvider>
        <Root />
      </PackProofProvider>
    </SafeAreaProvider>
  );
}
