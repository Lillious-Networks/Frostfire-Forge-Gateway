---
title: Animator
description: Cut a sprite sheet into frames, arrange them into animations and directions on a timeline, and export the metadata as JSON.
order: 130
---

The animator, titled "Animation Editor" in its window, turns a sprite sheet into animation metadata: which frames make up each animation and direction, how long each frame shows, and where it sits. Unlike the other tools it talks to no server. You load an image from your computer and export a JSON file. This page covers the workflow, every control, the keyboard shortcuts and the file it produces.

## Opening it

The animator is a normal page, not a popup tied to the game:

```text title="Route"
/animator
```

There is no chat command and no permission check. Anyone who can reach the website can open the page, and nothing they do there touches the game: all work stays in the browser until you export a file.

## Workflow

1. Load a sprite sheet image.
2. Set the frame size and split the sheet into frames.
3. Name the metadata and its image source.
4. Add an animation, then a direction for it.
5. Drag frames onto the timeline, set durations and positions.
6. Play it back, adjust, and export the JSON.

## Sprite sheet

The side pane starts with the sheet.

| Control | Notes |
| --- | --- |
| Load sprite sheet | Opens a PNG, JPEG or WebP image from your computer |
| Frame width, Frame height | Size of one frame in pixels. Both start at 64. |
| Columns, Rows | Leave empty for "Auto", or set how many frames the sheet has across and down |
| Split frames | Cuts the sheet into frames and fills the Frames strip |

:::warning The cut is fixed once made
After "Split frames", the four size fields are locked and the pane says "This sheet is cut into frames". To cut it another way, press New and start again.
:::

## Metadata

This section appears once a sheet is loaded.

| Control | Notes |
| --- | --- |
| Name | The name of the metadata, for example `player_body_base`. It becomes the file name of the export. |
| Image source | The sprite sheet file the metadata belongs to, for example `player_body_base.png` |
| Animation | The animation in view, with buttons to add, rename and delete one |
| Direction | The direction in view, with buttons to add, change and delete one |

An animation is a named set of directions, for example `idle`, `walk` or `attack`. A direction holds the actual frames.

### Directions

Adding or changing a direction opens a dialog:

| Field | Notes |
| --- | --- |
| Direction | Down, Up, Left, Right, Down left, Down right, Up left or Up right |
| Offset X, Offset Y | Pixels. Where this direction's frames start from. |
| Loop animation | Whether this direction loops in the game |

## Frames and timeline

The **Frames** card shows every frame cut from the sheet. Drag a frame onto the timeline or the stage to add it to the open direction. With no direction open a dropped frame is turned away, so add a direction first.

The **Timeline** card holds the open direction's frames in the order they play.

- Drag a step to move it in the order.
- Each step shows its frame number on the sheet and a duration field in milliseconds.
- "Reset position" puts the selected frame back at 0, 0.
- "Clear" takes every frame off this timeline. It cannot be undone.

The **stage** under the steps shows the selected frame around the centre point 0, 0.

| On the stage | Result |
| --- | --- |
| Drag a frame | Places it |
| Click the (x, y) label | Type the position |
| Scroll | Zoom |
| Shift + drag | Pan |

## Playback

| Control | Notes |
| --- | --- |
| Play, Pause | Plays the open direction with its frame durations |
| Stop | Stops and goes back to the first frame |
| Loop preview | Loops the preview only. Whether it loops in the game is set on the direction. |
| Readout | "Frame N of M" and the elapsed time in milliseconds |
| Scrubber | Shows when each frame starts along the length of the animation |

## Keyboard shortcuts

Shortcuts are ignored while the cursor is in a text field or a dialog is open.

| Key | Action |
| --- | --- |
| Arrow keys | Move the selected frame 1 pixel |
| `Tab` | Select the next frame |
| `Shift+Tab` | Select the previous frame |
| `Delete` or `Backspace` | Remove the selected frame from the timeline |
| `Ctrl+Z` | Undo |
| `Ctrl+Y` | Redo |
| `Enter` | Confirm a dialog |
| `Escape` | Cancel a dialog |

## Top bar

| Control | Notes |
| --- | --- |
| New | Starts again with nothing loaded |
| Import | Opens metadata exported earlier (a `.json` file), then asks you to locate its sprite sheet image |
| Autosave | Keeps the work in the browser and brings it back the next time the page opens |
| Export | Saves the metadata as `<Name>.json` |

Autosave stores the work in the browser's local storage on this computer only. Unticking it deletes the stored copy.

## The exported file

Export writes one JSON file. In browsers that support it you choose where to save it. Otherwise it is downloaded.

```json title="player_body_base.json"
{
  "name": "player_body_base",
  "imageSource": "player_body_base.png",
  "frameWidth": 64,
  "frameHeight": 64,
  "columns": 8,
  "rows": 4,
  "animations": {
    "walk": {
      "directions": {
        "down": {
          "frames": [0, 1, 2, 3],
          "frameDurations": [150, 150, 150, 150],
          "offsets": [
            { "x": 0, "y": 0 },
            { "x": 0, "y": 0 },
            { "x": 0, "y": 0 },
            { "x": 0, "y": 0 }
          ],
          "loop": true
        }
      }
    }
  }
}
```

| Key | Meaning |
| --- | --- |
| `frames` | Frame numbers on the sheet, in play order |
| `frameDurations` | How long each frame shows, in milliseconds |
| `offsets` | Position of each frame relative to the centre |
| `loop` | Whether the direction loops in the game |

## Using the result

The animator does not upload anything. The asset server keeps animation templates as JSON in its `animations` folder and sprite sheet images in its `spritesheets` folder, so that is where an exported file and its image belong. See [Asset Paths](#/assets/asset-paths) for the layout and how the asset server picks up new files.

Sprite sheets known to the asset server are what the appearance pickers of the [NPC Editor](#/tools/npc-editor) and the [Creature Editor](#/tools/creature-editor) offer.

## Tips

- Turn Autosave on before a long session. A closed tab otherwise loses everything that was not exported.
- Export often and keep the JSON files in version control beside the images.
- To extend an existing animation set, Import its JSON, choose the same sprite sheet when asked, and add to it.
- Build one direction completely, play it, and only then add the others. Timing mistakes are cheaper to fix once.
- Use the same frame size for every sheet that is layered on a body, such as armour and weapons, so the layers line up.
