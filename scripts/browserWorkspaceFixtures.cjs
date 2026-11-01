'use strict';
// Synthetic regression inputs, never loaded by production browser code.
module.exports = [
    {id:'schedule',host:'schedule.example',goal:'Read the schedule; preserve dates and sources.',turn:'Which of these falls on the following Friday?',
        html:'<h1>Schedule</h1><section class="card" data-id="7001"><h2>TEST river walk</h2><span class="date">6 Ноября 2026</span><span class="time">19:00</span><span>Payment at venue</span><a href="/walk-7001.html">Details</a></section>',title:'TEST river walk',attribute:'6 Ноября'},
    {id:'restaurant',host:'restaurant.example',goal:'Inspect restaurant details and prepare a draft only; ask for the party size.',turn:'Four guests; keep the draft unsubmitted.',
        html:'<main><h1>TEST Harbor Kitchen</h1><dl><dt>Address</dt><dd>12 Synthetic Lane</dd><dt>Opening hours</dt><dd>12:00–22:00</dd></dl><form><label>Guests<input name="guests" required></label><button>Continue</button></form></main>',title:'TEST Harbor Kitchen',attribute:'Synthetic Lane'},
    {id:'catalog',host:'catalog.example',goal:'Compare the synthetic lamps by price and power; do not buy.',turn:'The cheaper one, in blue; show its details.',
        html:'<h1>Lamps</h1><article class="entry"><h3>TEST Lamp Birch</h3><span itemprop="price">20 EUR</span><a href="/birch">Details</a></article><article class="entry"><h3>TEST Lamp Oak</h3><span itemprop="price">35 EUR</span><a href="/oak">Details</a></article>',title:'TEST Lamp Birch',attribute:'20 EUR'},
    {id:'research',host:'library.example',goal:'Read the list and detail sources and compare their maintenance requirements.',turn:'Open the second source and check its limitations.',
        html:'<h1>References</h1><ul><li class="result"><h3>TEST Method North</h3><a href="/north">Read</a></li><li class="result"><h3>TEST Method South</h3><a href="/south">Read</a></li></ul>',title:'TEST Method South',attribute:'Method South'},
    // Held-out task and layout: no card classes, no event/product fields, no action-specific parser.
    {id:'held-out-form',host:'permit.example',goal:'Prepare a synthetic equipment-loan request across two steps; never submit.',turn:'Use the later return date, and change the purpose to education.',
        html:'<main><h1>TEST Equipment loan</h1><dl><dt>Duration limit</dt><dd>14 days</dd></dl><form><label>Purpose<input name="purpose"></label><label>Return date<input type="date" name="return"></label><button>Next step</button></form></main>',title:'TEST Equipment loan',attribute:'14 days'},
];
