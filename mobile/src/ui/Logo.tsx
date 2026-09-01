import { Image, type ImageStyle, type StyleProp } from "react-native";

const LOGO = require("../../assets/icon.png");

export function Logo(props: { size?: number; style?: StyleProp<ImageStyle> }) {
  const size = props.size ?? 40;
  return (
    <Image
      source={LOGO}
      accessibilityLabel="PackProof"
      style={[{ width: size, height: size, borderRadius: 8 }, props.style]}
    />
  );
}
