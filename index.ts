import { ExtensionContext } from "@foxglove/extension";

import { initMainPanel } from "./MainPanel";
import { initSignalPlotPanel } from "./SignalPlotPanel";
import { initGlobalAnnotationTimelinePanel } from "./GlobalAnnotationTimelinePanel";
import { initVideoIndicatorPanel } from "./VideoIndicatorPanel";
import { initMergedAnnotatorPanel } from "./MergedAnnotatorPanel"; // NEW — experimental merge

export function activate(extensionContext: ExtensionContext): void {
  extensionContext.registerPanel({ name: "Main Panel", initPanel: initMainPanel });
  extensionContext.registerPanel({ name: "Signal Plot", initPanel: initSignalPlotPanel });
  extensionContext.registerPanel({ name: "Global Annotation Timeline", initPanel: initGlobalAnnotationTimelinePanel });
  extensionContext.registerPanel({ name: "Video Indicator", initPanel: initVideoIndicatorPanel });
  extensionContext.registerPanel({ name: "Merged Annotator (Experimental)", initPanel: initMergedAnnotatorPanel }); // NEW
}
