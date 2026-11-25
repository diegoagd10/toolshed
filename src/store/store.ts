import { Calls } from './calls.js'
import { openDatabase } from './database.js'
import { Files } from './files.js'
import { Keys } from './keys.js'
import { Links } from './links.js'

export function openStore(dataDir: string) {
  const database = openDatabase(dataDir)
  return {
    keys: new Keys(database),
    calls: new Calls(database),
    files: new Files(database, dataDir),
    links: new Links(database),
    close() {
      database.close()
    },
  }
}

export type Store = ReturnType<typeof openStore>
