export type StoreErrorCode = 'database_too_new' | 'file_not_found'

export class StoreError extends Error {
  override name = 'StoreError'
  readonly code: StoreErrorCode

  constructor(code: StoreErrorCode, message: string) {
    super(message)
    this.code = code
  }
}
