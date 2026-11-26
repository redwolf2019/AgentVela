import type { ColorValue } from "react-native";
import Svg, { Path } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedPath = withUniwind(Path);

export function T3Wordmark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  const aspectRatio = 90 / 83;
  return (
    <Svg
      accessibilityLabel="AgentVela"
      height={props.height}
      width={props.height * aspectRatio}
      viewBox="18 21 90 83"
    >
      <ThemedPath
        d="M18 42L42 32C46 53 50 74 53 94H40C31 77 23 60 18 42Z"
        color={props.color}
        colorClassName={props.colorClassName}
        fill="currentColor"
      />
      <ThemedPath
        d="M86 28L108 21C102 52 90 80 74 104H63C68 78 76 52 86 28Z"
        color={props.color}
        colorClassName={props.colorClassName}
        fill="currentColor"
      />
    </Svg>
  );
}
