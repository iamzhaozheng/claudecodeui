# Continue desktop Codex conversations from CloudCLI

CloudCLI can send messages to an existing conversation owned by the desktop
Codex app on the same computer. Open the original conversation in CloudCLI and
send a message normally. The desktop app must remain open.

- The original native conversation id, context, and CloudCLI group stay intact.
- CloudCLI discovers the desktop owner through its private local IPC socket and
  forwards the turn to that owner. It does not start another CLI writer for it.
- While the desktop is replying, a phone message waits for the turn to finish.
  Stopping that waiting message does not interrupt the preceding desktop turn.
- Replies to phone messages stream through CloudCLI. An open CloudCLI chat also
  follows new messages and completed reply items from desktop activity.
- Shared turns inherit the desktop conversation's permissions and workspace.
  The model and reasoning effort selected in CloudCLI may override the next turn.
  Command and file approval decisions are forwarded to the desktop owner.
- If no desktop owner exists, CloudCLI uses its regular Codex SDK path.

## Local connection

The default socket is `$CODEX_HOME/ipc/ipc.sock`, or
`~/.codex/ipc/ipc.sock` when `CODEX_HOME` is unset. An installation can override
it with `CLOUDCLI_CODEX_DESKTOP_SOCKET`. CloudCLI checks that the socket and its
directory belong to its own OS user and that the socket is private. Nothing new
is exposed over the network; the existing authenticated CloudCLI connection is
used by the browser.

This adapter uses the desktop app's internal, versioned follower protocol. The
current supported state protocol is version 11, start-turn is version 2, and
interrupt is version 4. A desktop update can change these versions. In that case
the adapter reports an error instead of taking over the writer or resubmitting
the message through another process.

Connection loss or a send timeout can happen after the desktop has received the
message. Check the original desktop conversation before sending it again. A
browser refresh reconnects the observer and reloads history from the desktop.
