'use strict';
// Synthetic component behavior only. No production domain or owner data.
module.exports = function formFixture({address=false,blocking=false,keyEvents=false,contact=false}={}) {
    const label=address?'TEST Delivery address':'TEST Destination';
    const control=address?`<div id="query" role="combobox" contenteditable="true" aria-label="${label}" aria-autocomplete="list" aria-controls="choices" aria-expanded="false"></div>`:
        `<input id="query" name="query" role="combobox" aria-label="${label}" aria-autocomplete="list" aria-controls="choices" aria-expanded="false">`;
    const options=address?[{label:'TEST Maple Street 12 — North district',value:'ADDRESS-NORTH'},{label:'TEST Maple Street 12 — South district',value:'ADDRESS-SOUTH'}]:
        [{label:'TEST Springfield — North airport (SPN)',value:'SPN'},{label:'TEST Springfield — South airport (SPS)',value:'SPS'}];
    return `<!doctype html><meta charset="utf-8"><title>TEST dynamic ${address?'address':'flight'} form</title>
<style>input,[contenteditable]{display:block;border:1px solid #222;min-height:32px;width:400px;margin:12px}#choices button{display:block}#banner{position:fixed;${blocking?'inset:0;background:#eee;z-index:100':'bottom:0;right:0;background:#eee'}}#calendar[hidden]{display:none}</style>
<main><h1>TEST ${address?'Equipment delivery':'Flight price research'}</h1>
<label>TEST Origin (site default, not owner preference)<input id="origin" value="TEST Site Default City" data-source="site-default"></label>
${contact?'<label>TEST Contact name<input id="private" name="full_name" autocomplete="name"></label><aside>Website example, not an owner fact: TEST Guessed Person</aside>':''}
<fieldset><legend>TEST ${address?'Location':'Route'}</legend>${control}<input type="hidden" data-selection-for="query" value=""><div id="choices" role="listbox" aria-label="TEST current suggestions"></div></fieldset>
<button id="date" disabled>TEST Choose date</button><section id="calendar" role="dialog" aria-label="TEST Date picker" hidden><button id="day">2030-01-15</button></section>
<output id="dateValue"></output><button id="final">TEST Submit request</button><output id="result"></output></main>
<aside id="banner">TEST optional notice <button id="close">Close TEST notice</button></aside>
<script>
window.TEST={inputs:0,blurs:0,selected:null,submissions:0,bannerClicks:0,sequence:0};
const options=${JSON.stringify(options)}, keyEvents=${keyEvents}, address=${address};
const valueOf=field=>address?field.innerText:field.value;
function attach(field){
 const query=()=>{window.TEST.inputs++;const sequence=++window.TEST.sequence;field.removeAttribute('data-selected-id');field.removeAttribute('data-selected-value');document.querySelector('[data-selection-for]').value='';document.querySelector('#date').disabled=true;
  const value=valueOf(field);if(!value)return;
  setTimeout(()=>{if(sequence!==window.TEST.sequence)return;let current=document.querySelector('#query');
   const replacement=current.cloneNode(true);current.replaceWith(replacement);current=replacement;attach(current);current.focus();current.setAttribute('aria-expanded','true');
   const list=document.querySelector('#choices');list.replaceChildren();for(const item of options){const button=document.createElement('button');button.setAttribute('role','option');button.setAttribute('data-value',item.value);button.textContent=item.label;
    button.onmousedown=event=>event.preventDefault();button.onclick=()=>{const current=document.querySelector('#query');if(address)current.innerText=item.label;else current.value=item.label;current.setAttribute(address?'data-selected-value':'data-selected-id',item.value);current.setAttribute('aria-expanded','false');document.querySelector('[data-selection-for]').value=item.value;window.TEST.selected=item.value;document.querySelector('#date').disabled=false;list.replaceChildren();};list.append(button);}
  },120);
 };
 if(keyEvents)field.onkeyup=query;else field.oninput=query;
 field.onblur=()=>{window.TEST.blurs++;window.TEST.sequence++;document.querySelector('#choices').replaceChildren();};
}
attach(document.querySelector('#query'));
document.querySelector('#close').onclick=()=>{window.TEST.bannerClicks++;document.querySelector('#banner').remove();};
document.querySelector('#date').onclick=()=>document.querySelector('#calendar').hidden=false;
document.querySelector('#day').onclick=()=>{document.querySelector('#dateValue').textContent='2030-01-15';document.querySelector('#calendar').hidden=true;};
document.querySelector('#final').onclick=()=>{window.TEST.submissions++;document.querySelector('#result').textContent='TEST submitted';};
</script>`;
};
