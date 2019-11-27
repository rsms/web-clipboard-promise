# Demo of clipboard promises on the Web

Demonstrates lazily-evaluated clipboard data on the Web platform.

Try it out: <https://rsms.me/web-clipboard-promise/>

It makes use of Shared Workers and the new-ish Clipboard API.
This demo only works in browsers with these APIs available and enabled.


## Clipboard access on the Web platform

Since the world wild web is unruly and content is accessed by a simple click or tap,
users can easily get into trouble if Web allowed freely reading and writing to your
clipboard. For instance, imagine if you copied your Gmail password from 1Password
and then clicked on some link saying "10 things you didn't know about cat hair!".
If that fishy website could just read your clipboard, it would now know your Gmail
password. That'd be bad.

Now "native" apps that you've installed can of course read your clipboard, but hopefully
you are careful when installing native apps. You are probably also using an OS that
provides additional safety like code signatures and sandboxing (like MS Windows and macOS.)

Clipboard access on the Web is therefore very limited and historically rarely used by
web applications for these reasons. There's a new API which at the time of writing this is
still in development and only available in Chrome and behind a feature flag in Firefox.

The stable and readily available clipboard API is not really a clipboard API, but part
of the Event API where the events `copy` and `paste` provides their handlers with a
`clipboardData` object.

Limitations with interfacing with the clipboard using the event API:

- Events only triggered from either OS standard keyboard shortcuts like cmd-C and ctrl-C.
  This limits the user interface you can provide users with. If you make your own context
  menu and want copy or paste in there, you're out of luck.
- The `clipboardData` object is only valid within the _same runloop frame_ as when the
  event handler is invoked. This object will appear completely empty if you keep a reference
  to it and look at it later, say with `setTimeout`. This limits
- The `clipboardData` object can be read from, accessing _some_ formats (browser dependent)
  but not all. Some browsers also filter and pre-process the data in the clipboard.
  For instance, Chrome re-encodes some image types to protect the user from malicious stuff
  like lolcat.jpeg. However some things may be lost in this process, [like image density
  metadata information.](https://bugs.chromium.org/p/chromium/issues/detail?id=355477)
- Perhaps the most important limitation is that writing to the clipboard must happen within
  the same runloop frame! If you need to call out to a Worker, access the network or just
  chunk up work to keep your UI responsive, you won't be able to write to the clipboard.


## Clipboard access via native OS APIs

Native clipboard APIs of most modern operating systems provide a "promise" model:

- Upon copy, a promise is made to provide the data requested
- The clipboard now contains one or more items each with one or more representations (data types).
  However, there's no actual data in the clipboard yet.
- Now, upon paste, the OS will ask the original code that responded to the copy earlier on
  to now provide data for a certain type.
- When the data is available the code that triggered paste receives the data and the copy-paste
  story is complete.

This technique has one very important upside: For payloads that requires a lot of work, copy is
virtually free (since no work is done on copy.)

When pasting somewhere the app that responded to copy in the first place is likely to be in the
background and so it freezing for a while during data generation is less bad for the
user experience.

Further, this allows apps like graphics editors to provide many different file formats without
having to encode an image in all those formats. For instance, it can promise to provide a
TIFF, PNG and JPEG image.
Later when paste happens, the code that responds to the paste can choose one of those formats.
Let's say it chooses PNG. Now, the original graphics app that populated the clipboard only needs
to generate the PNG image.


## What this code does

This demo is addressing some of the limitations of the Web platform by using a Shared Worker
substituting the OS clipboard manager, coordinating copy, paste and lazy data production between
apps.

It uses the new Clipboard API as well to populate the clipboard.

