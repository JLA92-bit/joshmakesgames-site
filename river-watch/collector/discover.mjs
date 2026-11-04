// River Watch - list the variables a gauge records (level, flow, storage, rainfall ...)
//   node collector/discover.mjs 406207 406283
// Use it to find extra series to add, e.g. Lake Eppalock storage level or a rainfall gauge.
// Created by Josh Avard
import { CFG, variableList } from './lib.mjs';

const ids = process.argv.slice(2);
if (!ids.length) { console.log('Usage: node collector/discover.mjs <site id> [more ids]'); process.exit(1); }
for (const id of ids) {
  for (const [pk, portal] of Object.entries(CFG.portals)) {
    for (const ds of portal.datasources) {
      try {
        const j = await variableList(pk, ds, id);
        const sites = (j.return && j.return.sites) || [];
        const vars = sites.flatMap((s) => s.variables || []);
        if (!vars.length) continue;
        console.log(`\n${id} via ${pk}:${ds} ${sites[0].site_details ? '- ' + sites[0].site_details.name : ''}`);
        for (const v of vars) console.log(`  ${v.variable}  ${v.name || ''} ${v.units ? '(' + v.units + ')' : ''}  ${v.period_start || ''} to ${v.period_end || ''}`);
      } catch (e) { /* try next */ }
    }
  }
}
