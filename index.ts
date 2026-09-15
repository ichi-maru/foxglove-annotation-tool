import { ExtensionContext } from "@foxglove/extension";

import { initExamplePanel } from "./ExamplePanel";
import { initSecondPanel } from "./SecondPanel";
import { initGlobalAnnotationTimelinePanel } from "./GlobalAnnotationTimelinePanel";
import { initVideoIndicatorPanel } from "./VideoIndicatorPanel";

export function activate(extensionContext: ExtensionContext): void {
  extensionContext.registerPanel({ name: "example-panel", initPanel: initExamplePanel });
  extensionContext.registerPanel({ name: "Signal Plot", initPanel: initSecondPanel });
  extensionContext.registerPanel({ name: "Global Annotation Timeline", initPanel: initGlobalAnnotationTimelinePanel });
  extensionContext.registerPanel({ name: "Video Indicator", initPanel: initVideoIndicatorPanel });
}
