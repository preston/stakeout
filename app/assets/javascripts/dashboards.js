$(function() {

	var slider = $('#refresh_period'),
		min = slider.attr('min'),
		max = slider.attr('max'),
		currentValue = $('#currentValue');
	

	// Control knob.
	slider.hide(); 	// Hide the orgiinal.
	$('#refresh_period_knob').knobKnob({
		snap : 10,
		value: 60,
		turn : function(ratio){
			// Changing the value of the hidden slider
			slider.val(Math.round(ratio*(max-min) + min));
			
			// Updating the current value text
			currentValue.html(slider.val());
		}
	});
	

	// Dashboard selection change..
	$('html').on('change', '#active_dashboard_id', function() {
		var id = active_dashboard_id();
		
		if(id == null) {
			console.log("Reloading since apparently we don't have the active dashboard in the GUI.");
			location.reload();			
		} else {
			console.log('Dashboard selection changed to ' + id + '.');

			// Let the server know to track state..
			$.ajax({
				type: 'POST',
				async: false,
				url: '/dashboards/active',
				data: {id: id},
				dataType: 'json',
				success: function(server_data, textStatus, jqXHR) {
					data = server_data;
					console.log('Notified server of dashboard change. ' + server_data);
					// console.log(textStatus);
					var d = $('<div/>', {'class' : 'loaded', html : 'Status: Loaded ' + data.length + ' records.'} );
					$('#data_status').html(d);		
				},
				error: function(jqXHR, textStatus, errorThrown) {
					var d = $('<div/>', {'class' : 'error', html : "Status: Couldn't load data file! Maybe try failing less?"} );
					$('#data_status').html(d);
					// alert("Ahh! The file couldn't be loaded. Maybe try failing less?");
				}
			});

			var s = $('#services');
			s.fadeOut('fast');
			setTimeout(function() {
				load_services();
				s.fadeIn('fast');
				}, 200);
			// s.effect('explode');
			// load_services();
			// s.effect('slideDown');
			// s.removeAttr( "style" ).hide().fadeIn();	
		}
	});
	
	// New dashboard dialog opening..
	// $('#new_dashboard_dialog').dialog({ autoOpen: false, modal: true, title: 'Create a dashboard!' })	;
	$('html').on('click', '#new_dashboard_button', function() {
		var d = $('#new_dashboard_dialog');
		d.modal('show');
		return false;
	});
	
	// New dashboard dialog form submission..
	$('html').on('click', '#new_dashboard_dialog .submit', function() {
		var f = $('#new_dashboard_dialog form')[0];
		submit_new_dashboard_form(f);
	});

	$('html').on('submit', '#new_dashboard_dialog form', function() {
		submit_new_dashboard_form(this);
	});	
	
	// Delete dashboard button..
	$('html').on('click', '#delete_dashboard_button', function() {
		console.log("Delete dashboard button clicked!");
		var id = active_dashboard_id();
		$.ajax({
			url: ('/dashboards/' + id),
			async: false,
			type: 'delete',
			dataType: 'json',
			success: function(json, textStatus, jqXHR) {
				console.log('Server successfully delete dashboard and auto-selected a new one: ' + json);
				var opt = $('#active_dashboard_id option[value="' + id + '"]');
				opt.remove(); // Remove the option for the select control.
			},
			error: function(jqXHR, textStatus, errorThrown) {
				$('#services').html("Oh noes.. could load services data from server. Something be wonky!");
			}
		});
		$('#active_dashboard_id').change(); // Trigger event handlers.	
		return false;
	});
	

	$('html').on('click', '#control_panel_visibility_button', function() {
		toggle_form_visible();
		return false;
	});



	// New service dialog show button..
	$('html').on('click', '#new_service_button', function() {
		console.log("Opening new service dialog for dashboard " + active_dashboard_id() + '.');
		var d = $('#new_service_dialog .modal-body');
		d.load('/dashboards/' + active_dashboard_id() + '/services/new');
		$('#new_service_dialog').modal('show');
		$("#service_name").focus();
		return false;
	});

	// New service dialog form submission..
	$('html').on('click', '#new_service_dialog .submit', function() {
		var f = $('#new_service_dialog form');
		submit_new_service_form(f);
	});
	
	$('html').on('submit', '#new_service_dialog form', function() {
		submit_new_service_form(this);
	});	
	
	// Remove service buttons..
	$('html').on('click', '.service_remove', function(e) {
		// AJAX RESTful DELETE..
		var id = this.dataset['id'];
		console.log("AJAX DELETEing service ID " + id + ".");
		$.ajax({
			url: '/dashboards/' + active_dashboard_id() + '/services/' + id,
			async: false,
			type: 'DELETE',
			dataType: 'json',
			success: function(json, textStatus, jqXHR) {
				console.log('Server successfully deleted service id ' + id + '. Removing from UI.');
				var s = $('#service_' + id);
				s.effect('fold');
			},
			error: function(jqXHR, textStatus, errorThrown) {
				$('#service_<%= service.id %>').highlight();
			}
		});  	
		return false;
	});
	

});


// Load services for the currently selected dashboard and update the screen..
function load_services() {
	$.ajax({
		url: ('/dashboards/' + active_dashboard_id() + '/services'),
		async: false,
		dataType: 'html',
		success: function(new_html, textStatus, jqXHR) {
			console.log('Received service data from server.');
			$('#services').html(new_html);		
		},
		error: function(jqXHR, textStatus, errorThrown) {
			$('#services').html("Oh noes.. could load services data from server! Do you have a network connection to it?");
			// alert("Ahh! The file couldn't be loaded. Maybe try failing less?");
		}
	});
}

function submit_new_service_form(form) {
	var action = form.attr('action');
	// console.log(action);
	// alert('hi');
	$.ajax({
		url: form.attr('action'),
		type: 'post',
		async: false,
		data: form.serialize(),
		success: function(html, textStatus, jqXHR) {
			// alert('success');
			console.log("Server successfully created service!");
			// load_services();
			$('#services').prepend(html);
			$('#new_service_dialog').modal('hide');
		},
		error: function(jqXHR, textStatus, errorThrown) {
			// alert('fail');
			console.log("Could not create service. :-(");
			$('#new_service_dialog .modal-body').html(jqXHR.responseText);
		}
	});
	return false;
}


function submit_new_dashboard_form(form) {
	var action = form.attr('action');
	console.log(action);
	$.post({
		url: action,
		async: false,
		data: form.serialize(),
		success: function(data, textStatus, jqXHR) {
			console.log("Server successfully created dashboard!");
			// Insert HTML for select box option.
			// Manually fire change event.
		},
		error: function(jqXHR, textStatus, errorThrown) {
			console.log("Could not create dashboard.");
		}
	});
	return false;
}

function active_dashboard_id() {
	var id = $('#active_dashboard_id').val();
	return id == '' ? null : id;
}


control_panel_visible = true;
function toggle_form_visible() {
	console.log("Toggling control panel visibility.");
	var cp = $('#control_panel');
	// var logo = $('#logo');
	var height = cp.height() - 20;
	var button = $('#control_panel_visibility_button');
	if(control_panel_visible) {
		cp.animate({marginTop: '-=' + height}, 400, function() { button.html('Show'); });
		// logo.fadeOut();
		// logo.animate({marginTop: '-=' + height}, 400, function() { });
	} else {
		cp.animate({marginTop: '+=' + height}, 400, function() { button.html('Hide') });
		// logo.fadeIn();
		// logo.animate({marginTop: '+=' + height}, 400, function() { });
	}
	control_panel_visible = !control_panel_visible;
}