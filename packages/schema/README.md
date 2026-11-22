# @wty.dev/aep-schema — AEP schemas

Zod schemas and types for the AEP `aep/1` wire envelope, the project model (tracks, clips,
notes, devices, tempo/meter maps), the operation set, actions and results. This is the single
source of truth for the protocol's data shapes; the published JSON Schemas under `schemas/` are
generated from it (`pnpm schemas`).

```sh
pnpm add @wty.dev/aep-schema
```

```ts
import { CoreRequest, CoreResult, Project, beatsToSeconds } from '@wty.dev/aep-schema';

const req = CoreRequest.parse({
  protocol: 'aep/1',
  session: 'sess-…',
  workspace: 'proj',
  id: 'req-…',
  credential: '…',
  action: 'project.inspect',
  version: 1,
  params: {},
});

const project = Project.parse(rawProjectJson);
const seconds = beatsToSeconds(8, project.tempo);
```

The protocol is specified in [`specs/core/SPECIFICATION.md`](../../specs/core/SPECIFICATION.md)
with the audio domain model in [`specs/audio/AUDIO-DOMAIN.md`](../../specs/audio/AUDIO-DOMAIN.md).
