/*
 * Handout Script
 *
 * Runs rendered Markdown handouts with embedded exercises and other features.
 */

// create a hover interaction
//   will either update an attribute of a target element inside this element,
//   or show only targets matching an indexed selector, as the user hovers over
//   elements matching a selector
function createHoverInteraction() {
  var elt = $(this);
  var selector = elt.data('selector');
  var target = $(elt.data('target'), elt);
  var pick = elt.data('pick');
  if (pick) {
    var updateTarget = function() {
      var filter = pick.replace(/\{index\}/g, $(this).index(selector)+1);
      target.hide().filter(filter).show();
    }
  } else {
    var attr = elt.data('attr');
    var template = elt.data('template');
    var updateTarget = function() {
      var value = template.replace(/\{index\}/g, $(this).index(selector));
      target.attr(attr, value);
    }
  }
  var update = function() {
    $(selector).removeClass('highlighted');
    $(this).addClass('highlighted');
    updateTarget.apply(this);
  }
  $(selector).addClass('hover-figure-select').on('click mouseenter', update);
  update.apply($(selector).first());
}

// move this element to follow the on-screen match to the selector
function followLeaders(selector) {
  return function() {
    var follower = $(this);
    var leaders = $(selector);
    Array.prototype.reverse.call(leaders); // iterate from bottom to top of page
    var current = undefined;
    $(document).on('scroll', function() {
      leaders.each(function() {
        if (this.getBoundingClientRect().top < window.innerHeight * 0.9) {
          if (current != this) {
            current = this;
            follower.remove();
            $(this).prepend(follower);
          }
          return false; // stop at bottommost leader element above the scroll position
        }
      });
    });
    $(document).scroll();
  };
}

// all exercises on the page
window.handoutExercises = [];

// serialize an exercise (or exercises) to JSON, converting jQuery DOM pointers to outline labels
function handoutExerciseJSON(exercise) {
  return JSON.stringify(exercise, function(key, value) {
    if (value && value.jquery) { return value.attr('data-outline'); }
    return value;
  });
}

// create an interactive exercise
function createExercise() {
  // build the exercise data structure with pointers to DOM nodes...
  $('.exercise-panel', this).each(function() {
    var exercise = {
      id: $(this).data('ex-id'),
      category: $(this).data('ex-category'),
      node: $(this),
      flags: {
        no_iterate: $(this).data('ex-no-iterate')
      },
      parts: $('.exercise-part', this).map(function() {
        return {
          node: $(this),
          choices: $('.exercise-choice', this).map(function() {
            var expected = $(this).data('ex-expected');
            var regex = $(this).data('ex-regex');
            return {
              node: $(this),
              expected: typeof expected == 'string' ? decodeURIComponent(expected) : expected,
              regex: typeof regex == 'string' ? decodeURIComponent(regex) : undefined,
              answer: $('.exercise-answer', this).first()
            };
          }).get()
        };
      }).get(),
      explanations: $('.exercise-explain', this).map(function() {
        return {
          node: $(this),
          html: this.innerHTML.trim()
        };
      }).get(),
      progress: $('.exercise-progress', this).first(),
      error: $('.exercise-error', this).first()
    };
    
    // ... and remember it
    window.handoutExercises.push(exercise);
    
    // handle check/explain buttons
    var handler = exercise.node.data('ex-remote') ? remoteHandler : localHandler;
    $('.exercise-submit, .exercise-reveal', this).on('click', clearError.bind(null, exercise));
    $('.exercise-submit', this).on('click', handler.onSubmit.bind(null, exercise));
    $('.exercise-reveal', this).on('click', handler.onReveal.bind(null, exercise));
    
    // collapsing exercise A to show exercise B might push the top of B off the page,
    // so scroll it back on
    $(this).on('shown.bs.collapse', function() {
      var top = this.getBoundingClientRect().top;
      if (top < 0) {
        $(document.body).animate({ scrollTop: document.body.scrollTop + top - 32 });
      }
    });
  });
}

function FN(method) { return method.call.bind(method); }
function AND(x, y) { return x && y; }
function OR(x, y) { return x || y; }

// read the value of a choice
function value(choice) {
  if (choice.node.is('.checkbox, .radio')) {
    return $('input', choice.node).prop('checked');
  }
  if (choice.node.is('.dropdown')) {
    return $('select option:selected', choice.node).text();
  }
  if (choice.node.is('.textfield')) {
    return $('input, textarea', choice.node).val().replace(/\s+/g, ' ').trim();
  }
  return undefined;
}

// is this part considered to have a value?
function hasValue(part) {
  return part.choices.map(function(choice) {
    if (choice.node.is('.checkbox')) {
      return true;
    }
    return value(choice);
  }).reduce(OR);
}

// return true iff phpRegex (of the form "/.../flags" where flags can only include i or m)
// matches value anchored
function matchRegex(phpRegex, value) {
  var m = phpRegex.match(/^\/(.+)\/([imxo]*)/);
  if (!m) throw new Error("regex should have format /.../[im]: " + phpRegex);
  var jsRegex = new RegExp("^(" + m[1] + ")$", m[2]);
  var string = value.toString();
  return string.match(jsRegex) != null;
}

// handle local check/explain
var localHandler = {
  onSubmit: function(exercise) {
    if ( ! displayExerciseAttempted(exercise)) { return; }
    exercise.correct = exercise.parts.map(function(part) {
      return part.correct = part.choices.map(function(choice) {
        var v = value(choice);
        choice.correct = choice.regex ? matchRegex(choice.regex, v) : (v == choice.expected);
        return choice.correct;
      }).reduce(AND);
    }).reduce(AND);
    displayExerciseAnswered(exercise);
  },
  onReveal: function(exercise) {
    displayExerciseReveal(exercise);
  }
};

// handle remote check/explain
var remoteHandler = {
  onSubmit: function(exercise) {
    if ( ! displayExerciseAttempted(exercise)) { return; }
    ajax(exercise, { reveal: exercise.flags.no_iterate }, function handleSubmit(response) {
      exercise.correct = response.result.correct;
      exercise.parts.forEach(function(part) {
        part.correct = response.result.parts.shift().correct;
      });
      if (response.exercise) {
        updateExercise(exercise, response);
      }
      displayExerciseAnswered(exercise);
    });
  },
  onReveal: function(exercise) {
    ajax(exercise, { reveal: true }, function handleReveal(response) {
      updateExercise(exercise, response);
      displayExerciseReveal(exercise);
    });
  }
};

// make a XHR for the given exercise: sends exercise JSON, displays progress and errors
function ajax(exercise, data, success) {
  exercise.progress.fadeIn();
  data.handout = exercise.node.data('ex-handout');
  data.student = handoutExerciseJSON(exercise);
  $.ajax({
    method: 'POST',
    url: exercise.node.data('ex-remote'),
    data: data,
    xhrFields: { withCredentials: true },
  }).done(success).fail(function(xhr, status, err) {
    showError(exercise, status, xhr.responseText || err || 'sorry about that');
    if (console && console.error) { console.error('exercise error', xhr.responseText, status, err); }
  }).always(function() {
    exercise.progress.hide();
  });
}

// update local exercise data with remote answers and explanations
function updateExercise(exercise, response) {
  // incorporate correct answers
  exercise.parts.forEach(function(part) {
    var respart = response.exercise.parts.shift();
    part.choices.forEach(function(choice) {
      choice.expected = respart.choices.shift().expected;
      choice.answer.html('');
    });
  });
  // incorporate explanations
  exercise.explanations.forEach(function(explain) {
    explain.node.html(response.exercise.explanations.shift().html);
  });
}

// display attempt feedback
//   return true iff all parts are attempted
function displayExerciseAttempted(exercise) {
  var complete = exercise.parts.map(function(part) {
    part.choices.forEach(function(choice) {
      choice.input = value(choice);
    });
    var complete = hasValue(part);
    part.node.toggleClass('exercise-incomplete', ! complete);
    return complete;
  }).reduce(AND);
  if ( ! complete) {
    if (exercise.flags.no_iterate) {
      showError(exercise, 'before you submit your answers', 'you must answer every part');
    } else {
      showError(exercise, 'before you check your answers', 'please attempt every part');
    }
  }
  return complete;
}

// display answer feedback
function displayExerciseAnswered(exercise) {
  exercise.parts.forEach(function(part) {
    part.node.addClass('exercise-answered').toggleClass('exercise-correct', part.correct);
  });
  $('.exercise-reveal', exercise.node).show();
  if (exercise.correct || exercise.flags.no_iterate) {
    $('.exercise-submit', exercise.node).prop('disabled', true);
    displayExerciseReveal(exercise);
  }
}

// display correct answers and explanations
function displayExerciseReveal(exercise) {
  exercise.parts.forEach(function(part) {
    part.choices.forEach(function(choice) {
      choice.node.filter('.checkbox, .radio').each(function() {
        if (choice.expected) {
          choice.answer.html('<span class="glyphicon glyphicon-check">');
        }
      });
      choice.node.filter('.dropdown, .textfield').each(function() {
        choice.answer.text(choice.expected);
      });
    });
  });
  $('.exercise-answer', exercise.node).fadeIn();
  $('.exercise-explain', exercise.node).slideDown();
  $('.exercise-reveal', exercise.node).prop('disabled', true);
}

// display an error
function showError(exercise, title, error) {
  var alert = $('<div>').addClass('alert alert-info alert-dismissable')
                        .text(': ' + error)
                        .prepend($('<strong>').text(title.replace(/\w/, FN(String.prototype.toUpperCase))))
                        .prepend($('<button>').addClass('close').attr('data-dismiss', 'alert').html('&times;'));
  exercise.error.empty().append(alert);
}

// remove any error
function clearError(exercise) {
  exercise.error.empty();
}

// create a video player link
function createVideo() {
  $(this).on('click', function() {
    $('.video-embed').empty();
    var player = $('<iframe>').addClass('embed-responsive-item').attr('src', $(this).attr('href'));
    $('.video-embed').append(player);
    $('.video-player').show();
    return false;
  });
}

// close the video player
function closeVideo() {
  $('.video-embed').empty();
  $('.video-player').hide();
}

// report visible parts of the page after scrolling
function createHeatmap() {
  var url = this.getAttribute('data-handx-url') + 'heatmap.php';
  var id = this.getAttribute('data-handx-id') || undefined;
  var win = $(window);
  var elts = document.querySelectorAll('[id]');
  win.on('scroll.handx', scrolled);
  function scrolled() {
    win.off('scroll.handx');
    setTimeout(function() {
      heat();
      win.on('scroll.handx', scrolled);
    }, 1000 * 2);
  }
  function heat() {
    var visible = Array.prototype.filter.call(elts, function(elt) {
      var rect = elt.getBoundingClientRect();
      return rect.y > 0 && rect.y + 20 < window.innerHeight && $(elt).is(':visible');
    }).map(function(elt) { return elt.id; });
    $.ajax({
      url: url, method: 'POST',
      xhrFields: { withCredentials: true },
      data: { id: id, visible: JSON.stringify(visible) },
    });
  }
}

//
// main
//

$(document).ready(function() {
  // wire up table of contents
  $('body').scrollspy({ target: '.table-of-contents', offset: 120 });
  
  // wire up interactive elements
  $('.hover-figure').each(createHoverInteraction);
  
  // wire up exercises
  $('.exercises').each(createExercise);
  $('.exercises-status').each(followLeaders('.handout-title, .exercises'));
  
  // wire up videos
  $('.video-play').each(createVideo);
  $('.video-close').on('click', closeVideo);
  
  // on delivered handouts...
  if (window.HANDOUT_DELIVER === undefined) {
    // wire up heatmap
    $('[data-handx-url]').not('.footer-archived ~ *').first().each(createHeatmap);
  }
  
  // handle fragment identifiers
  if (location.hash) {
    var elt = document.getElementById(decodeURIComponent(location.hash.substr(1)));
    if (elt) {
      $(elt).filter('.exercise-panel.collapse').addClass('in'); // jump to an exercise
      $('.exercise-panel.collapse', elt).addClass('in'); // jump to an exercise
      $(elt).nextAll('.exercise-panel.collapse').addClass('in'); // jump to header of exercise
      $(elt).parents('.exercise-panel.collapse').addClass('in'); // jump inside an exercise
      elt.scrollIntoView();
    }
  }
  
  window.handoutReady = true;
  
  if (window.HANDOUT_DELIVER) {
    // done rendering
    setTimeout(window.handoutDeliveryCallback, 0);
  } else {
    // ready callback
    if (window.HANDOUT_READY) { window.HANDOUT_READY(); }
    if (window.onHandoutReady) { window.onHandoutReady(); }
  }
});
