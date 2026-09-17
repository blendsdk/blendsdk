import { format } from 'prettier';
import { ConstantType } from '../database/index.js';
import { SchemaUtils } from '../schema/utils.js';

export class CTypeGenerator {
  async generate(ctypes: ConstantType) {
    const result: string[] = [];
    Object.entries(ctypes).forEach(([name, props]) => {
      const cName = SchemaUtils.snakeToPascalCase(name.replace(/\./gi, '_'));
      const pList: string[] = [];
      result.push(
        ...SchemaUtils.formatMultilineComment([
          `Constant type for relation ${name}`,
          `@export`,
          `@constant`,
        ])
      );
      result.push(`export const e${cName} = {`);
      pList.push(`$TABLE:'${name}'`);
      props.forEach(p => {
        pList.push(`${p.toUpperCase()}:'${p}'`);
      });
      result.push(pList.join(',\n'));
      result.push('}\n');
    });
    const src = await format(result.join('\n'), { parser: 'typescript' });
    return src;
  }
}
