do the following, making major/minor changes as needed:
- add offline support (for all files). follow something similar to what google docs does where you can select to make a file/folder (for folders, it updates offline state for all files inside of it even when things are added, deleted, and moved) available offline
- make a vector art editor. here's the prompt since it's a large project:
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
- note XML query thing should support adding/deleting notes
- add readme and license to repo
- you should be able to scroll down past the end of a note- not infinite though this is just so in mobile, words would never be hidden under the keyboard
- integrate all `.py` apps from `/temp/processing` into app, modifying as needed. with `/statements`, you can also insert into sorted- insertion basically just gets phrases from a txt file that are separated by \n newlines and it finds the phrase closest to it using the same scoring system as the sorting algorithm and adds it either before or after that phrase based on the scores of the phrases next to it too. also checks to make sure no duplicates are added using same duplicate logic. also `/statements` should be doing spellchecking and you can get text from it by entering a few phrases and then it returns phrases in the storage (you can set the amount returned) that are similar to the phrases entered. also I know that I said that `.txt` files are used, but replace all of that with multi line field UIs for input and text displays for output since now this is on an actual app. if I need a backend for any of this, suggest the best option for this project.
- basic midi DAW editor for just melodies or drum sequences- can record voice and store the audio file, app can also convert those audio files into midi.
- remove vault branding from google cloud console project and google apps script project, using "store". also for apps script proxy, provide instructions to the user on how to set one up (code should be minimal for the apps script (but the app should still be fast) so you might need to go and fix that if possible). the app script proxy code is at `/temp/appscript.gs`.
- vector art thing will need to handle circles and curves and layers
- app that shows images (on mobile you can take pictures of papers thru the app, but this thing takes any image) and basically what you can do is square select portions of the image to save as a separate image file- the app makes it a bit more high contrast and the user can use an drawing pen thing that gets its color from a color picker (allowing stuff to be "erased"). the app also converts any words into text on the page so you can copy paste text if needed.
- add android accessibility widget menu thingy that can take screenshots, and you can write text too for mobile