// River Watch - find gauges and list what they record
//   node collector/discover.mjs               find the gauges marked 'discover' (Coliban River, McIvor Creek)
//   node collector/discover.mjs 406207 406219 list the variables a gauge records (level, flow, storage, rainfall ...)
// Created by Josh Avard
import { CFG, variableList, discoverSites } from './lib.mjs';

const ids = process.argv.slice(2);
if (!ids.length) {
  const found = await discoverSites(true);
  for (const [slug, d] of Object.entries(found)) console.log(`${slug}: ${d.id ? d.id + ' ' + (d.name || '') : 'not found' + (d.error ? ' (' + d.error + ')' : '')}`);
  process.exit(0);
}
for (const id of ids) {
  for (const [pk, portal] of Object.entries(CFG.portals)) {
    for (const ds of portal.datasources) {
      try {
        const j = await variableList(pk, ds, id);
        const sitesRet = (j.return && j.return.sites) || [];
        const vars = sitesRet.flatMap((s) => s.variables || []);
        if (!vars.length) continue;
        console.log(`\n${id} via ${pk}:${ds} ${sitesRet[0].site_details ? '- ' + sitesRet[0].site_details.name : ''}`);
        for (const v of vars) console.log(`  ${v.variable}  ${v.name || ''} ${v.units ? '(' + v.units + ')' : ''}  ${v.period_start || ''} to ${v.period_end || ''}`);
      } catch { /* try next */ }
    }
  }
}
