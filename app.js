/*
 * fast-azn
 * This source code is licensed under the license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */
const
    request = require('request'),
    bodyParser = require('body-parser'),
    express = require('express'),
    crypto = require('crypto'),
    https = require('https'),
    cheerio = require('cheerio'),
    config = require('config'),
    async = require('async'),
    schedule = require('node-schedule'),
    jsonfile = require('jsonfile');
var app = express();
//var pg = require('pg');
app.set('port', process.env.PORT || 5000);
app.use(express.static('public'));
app.use(bodyParser.json({
    verify: verifyRequestSignature
}));
var currency_global = [];

const APP_SECRET = (process.env.MESSENGER_APP_SECRET) ?
    process.env.MESSENGER_APP_SECRET :
    config.get('appSecret');

// Arbitrary value used to validate a webhook
const VALIDATION_TOKEN = (process.env.MESSENGER_VALIDATION_TOKEN) ?
    (process.env.MESSENGER_VALIDATION_TOKEN) :
    config.get('validationToken');

const PAGE_ACCESS_TOKEN = (process.env.MESSENGER_PAGE_ACCESS_TOKEN) ?
    (process.env.MESSENGER_PAGE_ACCESS_TOKEN) :
    config.get('pageAccessToken');

// URL where the app is running (include protocol). Used to point to scripts and
// assets located at this address.
const SERVER_URL = (process.env.SERVER_URL) ?
    (process.env.SERVER_URL) :
    config.get('serverURL');

const GOOGLE_MAPS_TOKEN = (process.env.GOOGLE_MAPS_TOKEN) ?
    (process.env.GOOGLE_MAPS_TOKEN) :
    config.get('GOOGLE_MAPS_TOKEN');

if (!(APP_SECRET && VALIDATION_TOKEN && PAGE_ACCESS_TOKEN && SERVER_URL)) {
    console.error("Missing config values");
    process.exit(1);
}

//constants
const BUY_OPER = "buy";
const SELL_OPER = "sell";
const AZN = "azn";
const EUR = "eur";
const USD = "usd";
const SIR = "sir";
const strings_file = 'strings.json';
const coordinates_file = "coordinates.json";
const COUNT_OF_RESULT = 3;

const regex_usd = /((долл|doll|usd|бакс|baks|\$)\s*(\d+)|(\d+)\s*(долл|doll|usd|бакс|baks|\$))/i,
    regex_azn = /((мана|mana|azn)\s*(\d+)|(\d+)\s*(мана|mana|azn))/i,
    regex_sir = /((шир|шыр|şir|sir|sır|щир|shir)\s*(\d+)|(\d+)\s*(шир|шыр|şir|sir|sır|щир|shir))/i,
    regex_gbp = /((фунт|funt|gbp)\s*(\d+)|(\d+)\s*(фунт|funt|gbp))/i,
    regex_eur = /((евро|avro|evro|eur|\€)\s*(\d+)|(\d+)\s*(евро|avro|evro|eur|\€))/i,
    regex_rur = /((руб|rub|rur)\s*(\d+)|(\d+)\s*(руб|rub|rur))/i,
    regex_form = /(script|<|>|&lt|&gt)/i;

const curr_regexes = [{
        currency: USD,
        regex: /(долл|doll|usd|бакс|baks|\$)/i
    },
    {
        currency: AZN,
        regex: /(мана|mana|azn|азн)/i
    },
    {
        currency: SIR,
        regex: /(шир|шыр|şir|sir|sır|щир|shir)/i
    },
    {
        currency: EUR,
        regex: /(евро|avro|evro|eur|\€)/i
    }
];


strings = jsonfile.readFileSync(strings_file);
coordinates = jsonfile.readFileSync(coordinates_file);
//Global structures. Because design of Messenger Platform is so poor
var user_fetched_banks = {};
var user_current_conversion = {};

function verifyRequestSignature(req, res, buf) {
    var signature = req.headers["x-hub-signature"];

    if (!signature) {
        // For testing, let's log an error. In production, you should throw an
        // error.
        console.error("Couldn't validate the signature.");
    } else {
        var elements = signature.split('=');
        var method = elements[0];
        var signatureHash = elements[1];

        var expectedHash = crypto.createHmac('sha1', APP_SECRET)
            .update(buf)
            .digest('hex');

        if (signatureHash != expectedHash) {
            throw new Error("Couldn't validate the request signature.");
        }
    }
}
//fetch currencies
getAllCurrenciesToMem();
var scheduled_currency = schedule.scheduleJob('*/30 * * * *', function() {
    try {
        getAllCurrenciesToMem();
    } catch (e) {
        console.log("Crashed in schedule update at " + (new Date()).toISOString() + " with error: " + e + "\n");
    }
});
/*
 * Use your own validation token. Check that the token used in the Webhook
 * setup is the same token used here.
 *
 */
app.get('/webhook', function(req, res) {
    if (req.query['hub.mode'] === 'subscribe' &&
        req.query['hub.verify_token'] === VALIDATION_TOKEN) {
        console.log("Validating webhook");
        res.status(200).send(req.query['hub.challenge']);
    } else {
        console.error("Failed validation. Make sure the validation tokens match.");
        res.sendStatus(403);
    }
});

app.post('/webhook', function(req, res) {
    var data = req.body;
    // Make sure this is a page subscription
    if (data.object == 'page') {
        // Iterate over each entry
        // There may be multiple if batched
        data.entry.forEach(function(pageEntry) {
            var pageID = pageEntry.id;
            var timeOfEvent = pageEntry.time;

            // Iterate over each messaging event
            pageEntry.messaging.forEach(function(messagingEvent) {
                if (messagingEvent.optin) {
                    // receivedAuthentication(messagingEvent);
                    console.log('optin!!!');
                } else if (messagingEvent.message) {
                    receivedMessage(messagingEvent);
                }
                /*else if (messagingEvent.delivery) {
                receivedDeliveryConfirmation(messagingEvent);
                } */
                else if (messagingEvent.postback) {
                    receivedPostback(messagingEvent);
                } else if (messagingEvent.read) {
                    receivedMessageRead(messagingEvent);
                }
                /*else if (messagingEvent.account_linking) {
                receivedAccountLink(messagingEvent);
                } */
                else {
                    console.log("Webhook received unknown messagingEvent: ", messagingEvent);
                }
            });
        });

        // Assume all went well.
        //
        // You must send back a 200, within 20 seconds, to let us know you've
        // successfully received the callback. Otherwise, the request will time out.
        res.sendStatus(200);
    }
});

function receivedPostback(event) {
    try {
        var senderID = event.sender.id;
        var recipientID = event.recipient.id;
        var timeOfPostback = event.timestamp;
        var payload = event.postback.payload;
        sendTypingOn(senderID);
        switch (payload) {
            case 'get_best_three':
                getBestCurrency(senderID, BUY_OPER, USD);
                break;
            case 'get_started':
                sendChooseCurrencyQuickReply(senderID, false);
                break;
            default:
                sendTextMessage(senderID, strings["something_interesting"]);
        }
        console.log("Received postback for user %d and page %d with payload '%s' " +
            "at %d\n and at %s", senderID, recipientID, payload, timeOfPostback, (new Date()).toISOString());
    } catch (e) {
        console.error("Crashed in receivedPostback at " + (new Date()).toISOString() + " with error: " + e + "\n");
    }
    setTimeout(sendTypingOff, 1000, senderID);
}

function receivedMessage(event) {
    var senderID = event.sender.id;
    var recipientID = event.recipient.id;
    var timeOfMessage = event.timestamp;
    var message = event.message;

    console.log("Received message for user %d and page %d at %d with message:",
        senderID, recipientID, timeOfMessage);
    console.log(JSON.stringify(message));

    var isEcho = message.is_echo;
    var messageId = message.mid;
    var appId = message.app_id;
    var metadata = message.metadata;

    // You may get a text or attachment but not both
    var messageText = message.text;
    var messageAttachments = message.attachments;
    var quickReply = message.quick_reply;
    sendTypingOn(senderID);

    if (isEcho) {
        // Just logging message echoes to console
        console.log("Received echo for message %s and app %d with metadata %s",
            messageId, appId, metadata);
        return;
    } else if (quickReply) {
        var quickReplyPayload = quickReply.payload;
        console.log("Quick reply for message %s with payload %s",
            messageId, quickReplyPayload);
        if (quickReplyPayload.indexOf('send_location_quick_reply') !== -1) {
            console.log("in send_location_quick_reply zone");
            user_fetched_banks[senderID].active_bank = quickReplyPayload.substring(quickReplyPayload.indexOf('#') + 1);
            console.log("active_bank: " + user_fetched_banks[senderID].active_bank);
            console.log("coordinates: " + coordinates[user_fetched_banks[senderID].active_bank]);
            if (typeof coordinates[user_fetched_banks[senderID].active_bank] != "undefined" && coordinates[user_fetched_banks[senderID].active_bank] != null) {
                sendLocationQuickReply(senderID);
            } else {
                //send message before location quick reply
                sendTextMessage(senderID, "We do not currently have the coordinates of the branches of this bank");
                setTimeout(sendBestNValuesQuickReply, 1000, senderID, user_fetched_banks[senderID].banks, true);
            }
            // sendTextMessage(senderID, "BOOM");
        } else {
            switch (quickReplyPayload) {
                case 'sell_usd_quick':
                    getBestCurrency(senderID, SELL_OPER, USD);
                    break;
                case 'sell_eur_quick':
                    getBestCurrency(senderID, SELL_OPER, EUR);
                    break;
                case 'buy_usd_quick':
                    getBestCurrency(senderID, BUY_OPER, USD);
                    break;
                case 'buy_eur_quick':
                    getBestCurrency(senderID, BUY_OPER, EUR);
                    break;
                case 'conv_to_usd':
                    sendConvertOneCurrency(senderID, USD);
                    break;
                case 'conv_to_eur':
                    sendConvertOneCurrency(senderID, EUR);
                    break;
                case 'flow_end':
                    sendTextMessage(senderID, strings["thanks"]);
                    break;
                case 'send_location_quick_reply':
                    sendLocationQuickReply(senderID);
                    break;
                default:
                    sendTextMessage(senderID, "Quick reply tapped");
                    break;
            }
        }
        setTimeout(sendTypingOff, 500, senderID);
        //sendTextMessage(senderID, "Quick reply tapped");
        return;
    }
    if (messageText) {
        // If we receive a text message, check to see if it matches any special
        // keywords and send back the corresponding example. Otherwise, just echo
        // the text we received.

        //Detect currency convert request
        /*if (messageText.search(regex_azn) != -1 || messageText.search(regex_usd) != -1 ||
            messageText.search(regex_eur) != -1 || messageText.search(regex_gbp) != -1 ||
            messageText.search(regex_rur) != -1 || messageText.search(regex_sir) != -1) {
            currenciesByMessage(senderID, messageText);
            return;
        }*/
        //currency converter code
        var curr_by_message = [];
        for (var i = 0; i < curr_regexes.length; i++) {
            var tmp_regex_rslt = messageText.search(curr_regexes[i].regex);
            if (tmp_regex_rslt != -1) {
                curr_by_message.push({
                    position: tmp_regex_rslt,
                    currency: curr_regexes[i].currency
                });
            }
        }
        var digit_value = 0;
        try {
            digit_value = Number(messageText.match(/\d+/)[0]);
        } catch (e) {
            console.log("Crashed while getting digits at " + (new Date()).toISOString() + " with error: " + e + "\n");
        }

        if (curr_by_message.length > 0) {
            currenciesByMessage(senderID, messageText, curr_by_message, digit_value);
            return;
        }
        switch (messageText.toLowerCase()) {
            case 'start':
                sendChooseCurrencyQuickReply(senderID, false);
                break;
            case 'updatelol':
                getAllCurrenciesToMem();
                break;
            default:
                sendTextMessage(senderID, strings["start_tip"]);
                break;
        }
        return;
    } else if (messageAttachments) {
        if (message.attachments[0].payload.coordinates) {
            if (typeof user_fetched_banks[senderID] != "undefined" && typeof user_fetched_banks[senderID].active_bank != "undefined") {
                console.log("In attachments, user_id: " + senderID);
                getNearestObjects(senderID, message.attachments[0].payload.coordinates, user_fetched_banks[senderID].active_bank);
                return;
            }
        } else {
            sendTextMessage(senderID, "Message with attachment received");
        }
    }
    setTimeout(sendTypingOff, 500, senderID);
}

function receivedMessageRead(event) {
    var senderID = event.sender.id;
    var recipientID = event.recipient.id;
    // All messages before watermark (a timestamp) or sequence have been seen.
    var watermark = event.read.watermark;
    var sequenceNumber = event.read.seq;
    console.log("Received message read event for watermark %d and sequence " +
        "number %d", watermark, sequenceNumber);
}
//infoToSend contains bank name and user coordinates
/*var distanceMatrix = function(infoToSend,cb){
request({
uri:'https://maps.googleapis.com/maps/api/distancematrix/json',
qs:{
origins:infoToSend.lat0 + ',' + infoToSend.long0,
destinations:infoToSend.destinations,
mode: "walking",
language:'az-AZ',
key:GOOGLE_MAPS_TOKEN
},
method: 'GET'
}, function(error, response, body){
if(error){
cb(error);
} else {//TODO:обработать результаты и отсортировать
cb(null,body);
}
});
}*/

//user functions
// function getBestCurrency(senderID, operation, currency) {
// console.log("called getBestCurrency");
// request({
// uri: "https://azn.today/api/banks",
// method: "GET"
// }, function (error, response, body) {
// try {
// if (!error) {
// var $ = cheerio.load(body);
// var json_text = $.text();
////console.log(json_text);
// var json_json = JSON.parse(json_text);
// var current_day = json_json[Object.keys(json_json)[0]];
////console.log(JSON.stringify(current_day));
// var currencies_array = [];
////convert that goddamned api result format to more convenient
// for (var key in current_day) {
// if (current_day.hasOwnProperty(key)) {
////		currencies_array.push(current_day[key]);
////		push only preferred currency
// var item = {};
// item.name = current_day[key].name;
// item.currency = currency;
// for (var i = 0; i < current_day[key][operation].length; i++) {
// if (current_day[key][operation][i].name == currency) {
// item.operation = operation;
// item.value = current_day[key][operation][i].value;
// }
// }
// currencies_array.push(item);
// }
// }
////bubble sort for find best three bank. Yes, I know that it's bullshit, but I'm lazy
// var swapped;
// do {
// swapped = false;
// for (var i = 0; i < currencies_array.length - 1; i++) {
// if (currencies_array[i].value > currencies_array[i + 1].value) {
// var temp = currencies_array[i];
// currencies_array[i] = currencies_array[i + 1];
// currencies_array[i + 1] = temp;
// swapped = true;
// }
// }
// } while (swapped);
// var tmp_count_of_result = COUNT_OF_RESULT;
// for(var i = COUNT_OF_RESULT; i<currencies_array.length-1; i++){
// if(currencies_array[i] == currencies_array[i+1]){
// tmp_count_of_result++;
// }
// }
// console.log(JSON.stringify(currencies_array));
// var best_n = currencies_array.slice(0, tmp_count_of_result);
// /*message = "";
// for (var i = 0; i< best_three.length; i++){
// message += (typeof strings[best_three[i].name] != "undefined" ? strings[best_three[i].name] : best_three[i].name) + "  " + best_three[i].value + "\n";
// }
// sendTextMessage(senderID, message);
// setTimeout(sendChooseCurrencyQuickReply,1000,senderID,true);
// sendTextMessage(senderID, 'Desu');*/
// user_fetched_banks[senderID] = {};
// user_fetched_banks[senderID].banks = best_n;
// console.log("user_fetched_banks: " + JSON.stringify(user_fetched_banks));
// sendBestNValuesQuickReply(senderID, best_n, false);
// } else {
// console.log("Error in getBestCurrency at " + (new Date()).toISOString() + " with error: " + e + "\n");
// sendTextMessage(senderID, 'Error in getting messages');
// }
// } catch (e) {
// console.log("Crashed in getBestCurrency at " + (new Date()).toISOString() + " with error: " + e + "\n");
// sendTextMessage(senderID, 'Crashed in getting messages');
// }

// });
// }
function getBestCurrency(senderID, operation, currency) {
    try {
        console.log("In get best currency: ");
        console.log("operation: " + operation);
        console.log("currency: " + currency);
        var currency_local = currency_global;
        console.log("local_currency: " + JSON.stringify(currency_local));
        var swapped;
        if (operation == "sell") {
            do {
                swapped = false;
                for (var i = 0; i < currency_local.length - 1; i++) {
                    if (currency_local[i][currency][operation] > currency_local[i + 1][currency][operation]) {
                        var temp = currency_local[i];
                        currency_local[i] = currency_local[i + 1];
                        currency_local[i + 1] = temp;
                        swapped = true;
                    }
                }
            } while (swapped);
        } else {
            do {
                swapped = false;
                for (var i = 0; i < currency_local.length - 1; i++) {
                    if (currency_local[i][currency][operation] < currency_local[i + 1][currency][operation]) {
                        var temp = currency_local[i];
                        currency_local[i] = currency_local[i + 1];
                        currency_local[i + 1] = temp;
                        swapped = true;
                    }
                }
            } while (swapped);
        }

        /*var tmp_count_of_result = COUNT_OF_RESULT;
        for (var i = COUNT_OF_RESULT - 1; i < currency_local.length - 1; i++) {
            if (currency_local[i][currency][operation] != currency_local[i + 1][currency][operation] || tmp_count_of_result >= 10) {
                break;
            } else {
                tmp_count_of_result++;
            }
        }*/
        var best_n = [];
        for (var i = 0; i < currency_local.length; i++) {
            //detect if next bank's currency is equal to current bank's one
            if ((i >= COUNT_OF_RESULT &&
                    currency_local[i][currency][operation] != currency_local[i - 1][currency][operation]) || i >= 5) {
                break;
            }
            console.log("I: " + currency_local[i][currency][operation]);
            console.log("I+1: " + currency_local[i + 1][currency][operation]);
            best_n.push({
                name: currency_local[i].name,
                id: currency_local[i].id,
                value: currency_local[i][currency][operation]
            });
        }
        user_fetched_banks[senderID] = {};
        user_fetched_banks[senderID].banks = best_n;
        console.log("user_fetched_banks: " + JSON.stringify(user_fetched_banks));
        sendBestNValuesQuickReply(senderID, best_n, false);
    } catch (e) {
        console.log("Crashed in getBestCurrency at " + (new Date()).toISOString() + " with error: " + e + "\n");
        sendTextMessage(senderID, 'Crashed in getBestCurrency');
    }
}

function getBestByCurrency(operation, currency) {
    try {
        var currency_local = currency_global;
        console.log("local_currency: " + JSON.stringify(currency_local));
        var swapped;
        //var currency_low = currency.toLowerCase();
        do {
            swapped = false;
            for (var i = 0; i < currency_local.length - 1; i++) {
                if (currency_local[i][currency][operation] > currency_local[i + 1][currency][operation]) {
                    var temp = currency_local[i];
                    currency_local[i] = currency_local[i + 1];
                    currency_local[i + 1] = temp;
                    swapped = true;
                }
            }
        } while (swapped);
        var best_n = [];
        for (var i = 0; i < currency_local.length; i++) {
            //detect if next bank's currency is equal to current bank's one
            if ((i >= COUNT_OF_RESULT &&
                    currency_local[i][currency][operation] != currency_local[i - 1][currency][operation]) || i >= 5) {
                break;
            }
            // console.log("I: " + currency_local[i][currency][operation]);
            // console.log("I+1: " + currency_local[i + 1][currency][operation]);
            best_n.push({
                name: currency_local[i].name,
                id: currency_local[i].id,
                value: currency_local[i][currency][operation]
            });
        }
        return best_n[0];
    } catch (e) {
        console.log("Crashed in getBestByCurrency at " + (new Date()).toISOString() + " with error: " + e + "\n");
    }
}

function sendBestNValuesQuickReply(senderID, best_n, repeat_flag) {
    console.log("called sendBestNValuesQuickReply");
    console.log("best_n: " + JSON.stringify(best_n));
    try {
        var messageText = "";
        var messageData = {
            recipient: {
                id: senderID
            },
            message: {
                text: "",
                quick_replies: []
            }
        }
        for (var i = 0; i < best_n.length; i++) {
            //var bank_title = (typeof strings[best_n[i].name] != "undefined" ? strings[best_n[i].name] : best_n[i].name);
            var bank_title = best_n[i].name;
            messageData.message.text += bank_title + " - " + best_n[i].value + "\n";
            messageData.message.quick_replies.push({
                content_type: "text",
                title: bank_title,
                payload: "send_location_quick_reply#" + best_n[i].id
            })
        }
        messageData.message.text += "Select bank:";
        if (repeat_flag) {
            messageData.message.quick_replies.push({
                content_type: "text",
                title: "Done",
                payload: 'flow_end'
            });
        }
        callSendAPI(messageData);
    } catch (e) {
        console.log("Crashed in sendBestNValuesQuickReply at " + (new Date()).toISOString() + " with error: " + e + "\n");
        sendTextMessage(senderID, 'Crashed in sendBestNValuesQuickReply');
    }
}

function getNearestObjects(senderID, sentCoordinates, active_bank) {
    console.log("called getNearestObjects");
    var lat0 = sentCoordinates.lat;
    var long0 = sentCoordinates.long;
    var destinations = "";
    var toGoogle = [];
    console.log("active bank: " + active_bank);
    var current_coordinates = coordinates[active_bank];
    if (typeof current_coordinates != "undefined" && current_coordinates != null) {
        for (var i = 0; i < current_coordinates.length; i++) {
            destinations += current_coordinates[i].lat + "," + current_coordinates[i].long + ((i < current_coordinates.length - 1) ? "|" : "");
            toGoogle.push(current_coordinates[i]);
            toGoogle[i].index = i;
        }
        //console.log("Initial lat and long: " + lat0 + " " + long0 + " at " + (new Date()).toISOString());

        var distance_req = request({
            uri: 'https://maps.googleapis.com/maps/api/distancematrix/json',
            qs: {
                origins: lat0 + ',' + long0,
                destinations: destinations,
                mode: "walking",
                language: "az-AZ",
                key: GOOGLE_MAPS_TOKEN
            },
            method: 'GET',
        }, function(error, response, body) {
            try {
                if (typeof response !== "undefined") {
                    if (error && response.statusCode != 200) {
                        console.error("Failed calling Send API", response.statusCode, response.statusMessage, body.error);
                    } else {
                        var result = JSON.parse(body);
                        var elements = result.rows[0].elements;
                        for (var i = 0; i < toGoogle.length; i++) {
                            elements[i].name = toGoogle[i].name;
                            elements[i].lat = toGoogle[i].lat;
                            elements[i].long = toGoogle[i].long;
                            elements[i].index = toGoogle[i].index;
                        }
                        for (var j = elements.length - 1; j >= 0; j--) {
                            if (elements[j].status.toLowerCase() != "ok") {
                                elements.splice(j, 1);
                            }
                        }
                        if (typeof elements === "undefined" || elements.length == 0) {
                            //sendTextMessage(recipientID, strings.google_error_wrong_coordinates[using_language[recipientID]]);
                            console.log("Wrong coordinates selected" + " at " + (new Date()).toISOString());
                            return;
                        }
                        var swapped;
                        do {
                            swapped = false;
                            for (var i = 0; i < elements.length - 1; i++) {
                                if (elements[i].distance.value > elements[i + 1].distance.value) {
                                    var temp = elements[i];
                                    elements[i] = elements[i + 1];
                                    elements[i + 1] = temp;
                                    swapped = true;
                                }
                            }
                        } while (swapped);
                        var places = elements.slice(0, COUNT_OF_RESULT);
                        found_objects = [];
                        for (var i = 0; i < places.length; i++) {
                            found_objects.push(places[i].index);
                        }
                        sendTextMessage(senderID, "Nearest branches:");
                        setTimeout(sendLocation, 500, senderID, lat0, long0, places);
                    }
                } else {
                    console.error("Failed getting response from GoogleMapsApi" + " at " + (new Date()).toISOString());
                }
            } catch (e) {
                console.error("Crashed in getNearestObjects at " + (new Date()).toISOString() + " with error: " + e + "\n");
            }
        });
    } else {
        sendTextMessage(senderID, strings["no_branches"]);
        setTimeout(sendBestNValuesQuickReply, 1000, senderID, user_fetched_banks[senderID].banks, true);
    }
}

function sendLocation(recipientID, lat0, long0, places) {
    console.log("called sendLocation");
    try {
        var atm = {};
        var atms = [];
        var branchCounter = 0;
        for (var i = 0; i < places.length; i++) {
            atm = {};
            var zoom = 15 - Math.trunc(Math.log10(places[i].distance.value / 1000));
            console.log("Zoom : " + zoom);
            var badge_color;
            var label;
            /*if (places[i].name.toLowerCase().startsWith("access")) {
            badge_color = "91bbff";
            label = "A";
            } else if (places[i].name.toLowerCase().startsWith("pasha")) {
            badge_color = "af1621";
            label = "P";
            } else {
            badge_color = "1d2d70";
            label = "V";
            }*/
            badge_color = "91bbff";
            //label = "A";
            atm.title = places[i].name + ", " + "Distance" + ": " + (places[i].distance.value / 1000).toFixed(3) + " km";
            atm.image_url = "https://maps.googleapis.com/maps/api/staticmap?center=" + places[i].lat + "," + places[i].long + "&size=640x480&zoom=16&markers=color:0x" + badge_color + "%7C" + places[i].lat + "," + places[i].long + "&key=" + GOOGLE_MAPS_TOKEN;
            atm.item_url = "https://www.google.com/maps/dir/" + lat0 + "," + long0 + "/" + places[i].lat + "," + places[i].long + "/@" + (lat0 + places[i].lat) / 2 + "," + (long0 + places[i].long) / 2;
            console.log(atm.image_url);
            /*if (isBranch) {
            atm.buttons = [];
            atm.buttons.push({
            type: "postback",
            title: strings.read_more[using_language[recipientID]],
            payload: "branch_" + (branchCounter++)
            });
            }*/
            atms.push(atm);
        }
        var messageData = {
            recipient: {
                id: recipientID
            },
            message: {
                attachment: {
                    type: "template",
                    payload: {
                        template_type: "generic",
                        elements: atms
                    }
                }
            }
        };
        callSendAPI(messageData);
        setTimeout(sendBestNValuesQuickReply, 2000, recipientID, user_fetched_banks[recipientID].banks, true);
        //  sendBestNValuesQuickReply(senderID, best_n, false);
    } catch (e) {
        console.error("Crashed in sendLocation at " + (new Date()).toISOString() + " with error: " + e + "\n");
    }
}

function currenciesByMessage(senderID, messageText, curr_by_message, digit_value) {
    try {
        console.log("text: " + messageText);
        console.log("curr_by_message: " + JSON.stringify(curr_by_message));
        console.log("digit value: " + digit_value);
        //sendTextMessage(senderID, "Working on it");
        // var splitted_text = messageText.split(" ");
        // var cur_value;
        // var cur_from;
        // var cur_to;
        //calculate count of currency in message
        var message = strings["strict_currency_azn"];
        if (curr_by_message.length > 2) {
            message = strings["strict_currency"];
        } else if (curr_by_message.length == 2) {
            var from_curr;
            var to_curr;
            if (curr_by_message[0].position < curr_by_message[1].position) {
                from_curr = curr_by_message[0].currency;
                to_curr = curr_by_message[1].currency;
            } else {
                from_curr = curr_by_message[1].currency;
                to_curr = curr_by_message[0].currency;
            }
            if (from_curr == AZN) {
                var best_n = getBestByCurrency(SELL_OPER, to_curr);
                console.log("best_n: " + JSON.stringify(best_n));
                message = "Best bank: " + best_n.name + ", value: " + (digit_value / Number(best_n.value)).toFixed(2) + " " + to_curr.toUpperCase();
            } else if (to_curr == AZN) {
                var best_n = getBestByCurrency(BUY_OPER, from_curr);
                console.log("best_n: " + JSON.stringify(best_n));
                message = "Best bank: " + best_n.name + ", value: " + (Number(best_n.value) * digit_value).toFixed(2) + " AZN";
            }
        } else if (curr_by_message.length == 1) {
            console.log("One currency: " + curr_by_message[0].currency);
            //Currently for azn only
            if (curr_by_message[0].currency == USD || curr_by_message[0].currency == EUR) {
                var best_n = getBestByCurrency(BUY_OPER, curr_by_message[0].currency);
                message = "Best bank: " + best_n.name + ", value: " + (Number(best_n.value) * digit_value).toFixed(2) + " AZN";
            } else if (curr_by_message[0].currency == AZN) {
                console.log("One currency azn");
                //write current conversion in global object for share between functions
                user_current_conversion[senderID] = {};
                user_current_conversion[senderID].currency_from = AZN;
                user_current_conversion[senderID].digit_value = digit_value;
                sendConvertOneCurrencyQuickReply(senderID);
                return;
            } else {
                message = strings["start_tip"];
            }
        } else {
            console.log("Zero currency");
            message = strings["start_tip"];
        }
        sendTextMessage(senderID, message);
    } catch (e) {
        console.error("Crashed in currenciesByMessage at " + (new Date()).toISOString() + " with error: " + e + "\n");
    }
}

//get all currencies and store in db
function getAllCurrencies() {
    request({
        uri: "https://azn.today/api/banks",
        method: "GET"
    }, function(error, response, body) {
        if (!error) {
            try {
                var $ = cheerio.load(body);
                var json_text = $.text();
                //console.log(json_text);
                var json_json = JSON.parse(json_text);
                var current_day = json_json[Object.keys(json_json)[0]];
                var currencies_array = [];
                //convert that goddamned api result format to more convenient
                for (var key in current_day) {
                    if (current_day.hasOwnProperty(key)) {
                        currencies_array.push(current_day[key]);
                        //push only preferred currency
                        //TODO:change it
                        var item = {};
                        item.name = current_day[key].name;
                        item.currency = currency;
                        for (var i = 0; i < current_day[key][operation].length; i++) {
                            if (current_day[key][operation][i].name == currency) {
                                item.operation = operation;
                                item.value = current_day[key][operation][i].value;
                            }
                        }
                        currencies_array.push(item);
                    }
                }
            } catch (e) {
                console.log("Crashed in getAllCurrencies at " + (new Date()).toISOString() + " with error: " + e + "\n");
                sendTextMessage(senderID, 'Crashed in getAllCurrencies');
            }
        } else {
            console.log("Error in getAllCurrencies at " + (new Date()).toISOString() + " with error: " + e + "\n");
            sendTextMessage(senderID, 'Error in getAllCurrencies');
        }
    });
}

//get all currency and store in memory. TODO: store in db
function getAllCurrenciesToMem() {
    var url = 'http://azn.today/';
    currency_global = [];
    request(url, function(err, resp, body) {
        if (err) {
            console.log('error')
        } else {
            $ = cheerio.load(body);
            $('#basic-mezenne > tbody > tr').each(function(i, tr) {
                $tr = $(tr);
                var bank_name = "";
                var bank_id = "";
                if ($tr.children().eq(0).find('h4').length) {
                    bank_name = $tr.children().eq(0).children('h4').text().trim();
                    //create bank id from it's name
                    bank_id = bank_name.toLowerCase().replace(/ç/g, 'c').replace(/ə/g, 'a').replace(/ğ/g, 'g').replace(/ı/g, 'i').replace(/ö/g, 'o').replace(/ş/g, 's').replace(/ü/g, 'u').replace(/\s/g, '').trim();
                }
                var tmp_currency = {
                    name: bank_name,
                    id: bank_id,
                };
                tmp_currency.usd = {};
                //I need that bullshit for retrieve only text from td.
                tmp_currency.usd.buy = Number($tr.children().eq(1).contents().filter(function() {
                    return this.nodeType == 3;
                })[0].nodeValue).toFixed(4);
                tmp_currency.usd.sell = Number($tr.children().eq(2).contents().filter(function() {
                    return this.nodeType == 3;
                })[0].nodeValue).toFixed(4);

                tmp_currency.eur = {};
                tmp_currency.eur.buy = Number($tr.children().eq(3).contents().filter(function() {
                    return this.nodeType == 3;
                })[0].nodeValue).toFixed(4);
                tmp_currency.eur.sell = Number($tr.children().eq(4).contents().filter(function() {
                    return this.nodeType == 3;
                })[0].nodeValue).toFixed(4);
                currency_global.push(tmp_currency);
            });
        }
        console.log(JSON.stringify(currency_global));
    });
}

//that must be rewritten in future
function convertFromAZN(senderID, currency) {
    var best_n = getBestByCurrency(SELL_OPER, currency);
    console.log("best_n: " + JSON.stringify(best_n));
    message = "Best bank: " + best_n.name + ", value: " + (user_current_conversion[senderID].digit_value / Number(best_n.value)).toFixed(2) + " " + currency.toUpperCase();
    sendTextMessage(senderID, message);
    //TODO: delete user operation object from global object
}

//quick replies
function sendChooseCurrencyQuickReply(senderID, next_flag) {
    console.log("called sendChooseCurrencyQuickReply");
    var messageData = {
        recipient: {
            id: senderID
        },
        message: {
            text: strings["select_currency"] + ":",
            quick_replies: [{
                content_type: "text",
                title: "Sell USD",
                payload: "sell_usd_quick"
            }, {
                content_type: "text",
                title: "Buy USD",
                payload: "buy_usd_quick"
            }, {
                content_type: "text",
                title: "Sell EUR",
                payload: "sell_eur_quick"
            }, {
                content_type: "text",
                title: "Buy EUR",
                payload: "buy_eur_quick"
            }]
        }
    }
    if (next_flag) {
        messageData.message.quick_replies.push({
            content_type: "text",
            title: "Done",
            payload: "flow_end"
        });
    }
    callSendAPI(messageData);
}

function sendChooseNext(senderID) {
    console.log("called sendChooseNext");
    var messageData = {
        recipient: {
            id: senderID
        },
        message: {
            text: strings["select_currency"] + ":",
            quick_replies: [{
                content_type: "text",
                title: "Sell USD",
                payload: "sell_usd_quick"
            }, {
                content_type: "text",
                title: "Buy USD",
                payload: "buy_usd_quick"
            }, {
                content_type: "text",
                title: "Sell EUR",
                payload: "sell_eur_quick"
            }, {
                content_type: "text",
                title: "Buy EUR",
                payload: "buy_eur_quick"
            }]
        }
    }
    callSendAPI(messageData);
}

function sendConvertOneCurrencyQuickReply(senderID) {
    //currently is azn only
    console.log("called oneCurrencyQuickReply");
    var messageData = {
        recipient: {
            id: senderID
        },
        message: {
            text: strings["select_currency"] + ":",
            quick_replies: [{
                content_type: "text",
                title: "USD",
                payload: "conv_to_usd"
            }, {
                content_type: "text",
                title: "EUR",
                payload: "conv_to_eur"
            }]
        }
    }
    callSendAPI(messageData);
}

function sendConvertOneCurrency(senderID, currency) {
    try {
        if (typeof user_current_conversion[senderID] != "undefined" && user_current_conversion[senderID] != null) {
            var best_n = getBestByCurrency(SELL_OPER, currency);
            console.log("best_n: " + JSON.stringify(best_n));
            message = "Best bank: " + best_n.name + ", value: " + (user_current_conversion[senderID].digit_value / Number(best_n.value)).toFixed(2) + " " + currency.toUpperCase();
            sendTextMessage(senderID, message);
        } else {
            sendTextMessage(senderID, "User\'s conversion is null");
        }
    } catch (e) {
        "Crashed in sendConvertOneCurrency at " + (new Date()).toISOString() + " with error: " + e + "\n"
    }
}

//system functions
function sendTypingOn(recipientID) {
    try {
        //console.log("Turning typing indicator on");
        var messageData = {
            recipient: {
                id: recipientID
            },
            sender_action: "typing_on"
        };
        callSendAPI(messageData);
    } catch (e) {
        console.error("Crashed in sendTypingOn at " + (new Date()).toISOString() + " with error: " + e + "\n");
    }
}

function sendTypingOff(recipientID) {
    try {
        var messageData = {
            recipient: {
                id: recipientID
            },
            sender_action: "typing_off"
        };
        callSendAPI(messageData);
    } catch (e) {
        console.error("Crashed in sendTypingOff at " + (new Date()).toISOString() + " with error: " + e + "\n");
    }
}

function sendTextMessage(recipientID, messageText) {
    try {
        var messageData = {
            recipient: {
                id: recipientID
            },
            message: {
                text: messageText,
                metadata: "DEVELOPER_DEFINED_METADATA"
            }
        };
        callSendAPI(messageData);
    } catch (e) {
        console.error("Crashed in sendTextMessage at " + (new Date()).toISOString() + " with error: " + e + "\n");
    }
}

//location code
function sendLocationQuickReply(senderID) {
    console.log("called sendLocationQuickReply");
    var messageData = {
        recipient: {
            id: senderID
        },
        message: {
            text: "Please share your location",
            quick_replies: [{
                content_type: "location"
            }]
        }
    }
    callSendAPI(messageData);
}

//sends information with fb api
function callSendAPI(messageData) {
    try {
        request({
            uri: 'https://graph.facebook.com/v2.6/me/messages',
            qs: {
                access_token: PAGE_ACCESS_TOKEN
            },
            method: 'POST',
            json: messageData
        }, function(error, response, body) {
            if (!error && response.statusCode == 200) {
                if (typeof response !== "undefined") {
                    var recipientID = body.recipient_id;
                    var messageId = body.message_id;
                    if (messageId) {
                        console.log("Successfully sent message with id %s to recipient %s at %s",
                            messageId, recipientID, (new Date()).toISOString());
                    } else {
                        console.log("Successfully called Send API for recipient %s at %s",
                            recipientID, (new Date()).toISOString());
                    }
                } else {
                    console.error("Failed calling Send API", response.statusCode, response.statusMessage, body.error + " time:" + (new Date()).toISOString());
                }
            } else {
                if (typeof response !== "undefined") {
                    console.error("Failed getting response from Send API, time " + (new Date()).toISOString() + ", error:" + error + ", body:" + JSON.stringify(body));
                } else {
                    console.error("Failed getting response from Send API, time " + (new Date()).toISOString() + ", response: " + response);
                }
            }
        });
    } catch (e) {
        console.error("Crashed in callSendAPI at " + (new Date()).toISOString() + " with error: " + e + "\n");
    }
}
app.listen(app.get('port'), function() {
    console.log('Node app is running on port', app.get('port'));
});