import{S as d,q as i}from"./api.BxOuvlSt.js";const l=document.getElementById("rss-table");function s(e){return e.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}async function n(){try{const o=(await i()).sessions.filter(t=>t.rss_mb!==null).sort((t,a)=>(a.rss_mb??0)-(t.rss_mb??0));if(o.length===0){l.innerHTML='<p class="text-xs" style="color: var(--text-muted)">No session memory data</p>';return}let c=0,r=`<table class="w-full text-sm"><thead><tr class="text-left text-xs" style="color: var(--text-muted)">
        <th class="pb-2 pr-4">Session</th><th class="pb-2 pr-4">RSS</th><th class="pb-2">Activity</th>
      </tr></thead><tbody>`;for(const t of o){const a=t.activity==="active"?"var(--accent-green)":t.activity==="idle"?"var(--accent-yellow)":"var(--text-muted)";r+=`<tr style="border-top: 1px solid var(--border)">
          <td class="py-1.5 pr-4">${s(t.name)}</td>
          <td class="py-1.5 pr-4" style="color: var(--text-secondary)">${s(String(t.rss_mb))}MB</td>
          <td class="py-1.5" style="color: ${a}">${s(t.activity??"-")}</td>
        </tr>`,c+=t.rss_mb??0}r+=`<tr style="border-top: 1px solid var(--border)">
        <td class="py-1.5 pr-4 font-medium" style="color: var(--text-muted)">Total</td>
        <td class="py-1.5 pr-4 font-medium" style="color: var(--text-secondary)">${c}MB</td>
        <td></td>
      </tr></tbody></table>`,l.innerHTML=r}catch(e){l.innerHTML=`<p class="text-xs" style="color: var(--accent-red)">Error: ${s(e.message)}</p>`}}n();const p=new d;p.on("state",()=>n());
