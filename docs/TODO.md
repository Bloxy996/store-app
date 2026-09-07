# TODO

Do the following, making major/minor changes as needed. Not all items need
to land in one pass — tackle one at a time and check it off here when done.
See `CLAUDE.md` for architecture context.

- [ ] **Offline support** (all files). Similar to Google Docs: select a
      file/folder to make available offline; for a folder, offline state
      propagates to everything inside it, including files later added,
      deleted, or moved. Needs an architecture decision before code, since
      it's in tension with `CLAUDE.md` section 3.1 (zero local note-content
      storage): (a) whether 3.1 gets a scoped, explicit, user-opted-in
      exception for offline files only (content stored in IndexedDB,
      documented in 3.1 itself, not a quiet workaround), (b) the
      conflict-resolution story for a file edited offline and also changed
      on Drive before reconnecting, and (c) per-folder propagation as a
      live rule evaluated against the vault tree, not a one-time flag
      copied onto children.

- [ ] **Vector art editor** — large project. Handles circles, curves, and
      layers in addition to the spec below.
  ```
  Act as a Senior Graphics Software Engineer and make a web-based Topological Vector Art Editor.
  Instead of traditional freehand brushes or disconnected paths, this editor treats artwork as a unified mesh or wireframe. The core philosophy is "Dynamic Binding": when lines intersect or join, they become structurally linked.
  Here are the specific mechanics, tools, and rules the editor must follow:
  1. Rendering & Styling Rules (Strict)
  Sharp Joints: There are no rounded corners or Bezier curves. All line joints must be rendered as sharp (miter) joints.
  Dynamic Z-Index (Weight-based): The rendering engine must automatically sort the draw order of lines based on their thickness. Lines with a heavier stroke weight must always appear on top of lines with a lighter stroke weight.
  Parametric Strokes: Every line has editable thickness and color.
  Live Editing: Selecting a line allows real-time adjustment of its properties.
  Eyedropper: Clicking an existing line samples its exact weight and color to the active tool.
  2. Core Tools
  Segment Tool: Click and drag to create a single straight line segment.
  Polyline Tool: Creates a continuous string of connected lines sharing the same style. Clicking creates a new node; closing the shape or double-clicking ends it.
  Subdivision (Add Node): Clicking anywhere on an existing line segment instantly creates a new vertex at that coordinate, splitting the line and allowing the user to pull the new joint.
  Vector Flood Fill: Detects enclosed areas bounded by connected/overlapping lines and fills the negative space with color.
  3. The Topology & Snapping Engine
  Connections act as physical joints. The snapping engine includes:
  Magnetic Node Snapping: Start/end points automatically snap to existing nodes.
  Edge Snapping: Nodes can snap to a mathematical point along the length of an existing line.
  Axis Snapping: Holding a modifier key (or automatic detection) snaps the current line being drawn to perfect horizontal or vertical axes.
  Relative Alignment Snapping (Smart Guides): When moving a point, temporary alignment lines appear, allowing the user to snap the point to the X or Y coordinates of other existing points on the canvas.
  Dynamic Binding: If Line A is connected to Line B at Point C, dragging Point C stretches both lines simultaneously. Nodes snapped to the middle of an edge slide along that edge when dragged.
  Tear-Away Disconnect: If a node connected to an edge is forcefully dragged away from the line's trajectory, the bond breaks so it can be reconnected elsewhere.
  4. Object Management
  Smart Grouping: Users can marquee-select and group lines. Clicking one line selects the group.
  Global Transforms: Grouped objects get a bounding box to move, scale, and rotate the whole shape.
  Local Transforms: Users can double-click into a group to access the underlying mesh, moving individual nodes without ungrouping.
  5. File Data
  The file must store Title and Description metadata.
  The math-based structure should be structured so it can eventually be exported to standard vector formats like SVG.
  ```

- [ ] Integrate all `.py` apps from `/temp/processing` into the app,
      modifying as needed (after this task, `/temp/processing` should be deleted):
  - `reader.py` should be accessing folders/files on the user's hardrive,
    but has simmilar logic to the XML query thing
  - `/statements`: support sorted-insertion — given phrases from a
    newline-separated `.txt` file, find the closest existing phrase using
    the same scoring system as the sorting algorithm, and insert before or
    after it based on the neighboring phrases' scores; check for
    duplicates using the same duplicate logic already in place.
  - `/statements` should also do spellchecking, and support a lookup mode:
    enter a few phrases and get back the N most similar stored phrases (N
    configurable).
  - Replace the `.txt`-file-based I/O with real app UI: multi-line input
    fields and text displays for output.
  - If a backend is needed for any of this, suggest the best option for
    this project.

- [ ] Basic MIDI DAW editor for melodies or drum sequences — can record
      voice and store the audio file; app can also convert those audio
      files into MIDI.

- [ ] Image app: shows images (on mobile, can take pictures of papers
      through the app; otherwise takes any image). Square-select portions
      of the image to save as a separate image file; the app increases
      contrast on the selection, and a drawing-pen tool (color from a
      color picker) can "erase"/draw on it. Also does OCR so any words on
      the page can be copied as text.

- [ ] Add an Android accessibility widget menu that can take screenshots
      and also accept typed text, for mobile.