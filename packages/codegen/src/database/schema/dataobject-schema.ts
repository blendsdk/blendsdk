export class DataObjectSchema {
  protected name: string;
  protected _comment: string | undefined;

  constructor(name: string) {
    this.name = name;
  }

  comment(comment: string) {
    this._comment = comment;
    return this;
  }

  getComment() {
    return this._comment;
  }

  getName() {
    return this.name;
  }
}
