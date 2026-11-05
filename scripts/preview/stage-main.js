// The preview's stagehand, in a 0px block: opens what only a click opens, the way the click does.
//   herdr-app do demo-stage.view:<x>|<y>|<root>|<path>   t3-files' viewer on that file, its top left at x, y
import { View, div } from "gpui-kit";
import { nextCommand, openOverlay } from "herdr";

export default class Stage extends View {
  init(_props, cx) {
    cx.spawn(async () => {
      for (;;) {
        const c = await nextCommand(), i = c.indexOf(":"), name = c.slice(0, i), arg = c.slice(i + 1);
        if (name === "view") {
          const [x, y, root, path] = arg.split("|");
          openOverlay({ mod: "t3-files", kind: "window", key: "t3-files:view", width: 780, height: 560,
            at: { x: Number(x), y: Number(y) }, props: { viewer: { root, path, on: null } } });
        }
      }
    });
  }
  render() { return div(); }
}
