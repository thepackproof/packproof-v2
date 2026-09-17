import { Modal, type ModalProps } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

/** Modals have their own native window and must measure their own safe area. */
export function AppModal({ children, ...props }: ModalProps) {
  return (
    <Modal {...props} statusBarTranslucent navigationBarTranslucent>
      <SafeAreaProvider>{children}</SafeAreaProvider>
    </Modal>
  );
}
