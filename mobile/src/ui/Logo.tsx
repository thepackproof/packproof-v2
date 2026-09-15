import { Image, type ImageStyle, type StyleProp } from "react-native";
import { useTheme } from "../theme/ThemeProvider";

const LOGO = require("../../assets/packproof-symbol.png");
const LOGO_DARK = require("../../assets/packproof-symbol-reversed.png");

export function Logo(props: { size?: number; style?: StyleProp<ImageStyle> }) {
  const size = props.size ?? 40;
  const { scheme } = useTheme();
  return (
    <Image
      source={scheme === "dark" ? LOGO_DARK : LOGO}
      accessibilityLabel="PackProof"
      style={[{ width: size, height: size, borderRadius: 0 }, props.style]}
    />
  );
}
